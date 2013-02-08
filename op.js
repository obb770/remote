'use strict';

var http = require('http'),
    util = require('util'),
    fs = require('fs'),
    path = require('path'),
    port = (process.argv.length > 2 && parseInt(process.argv[2])) || 8124,
    wwwRoot = 'www',
    mediaDir = 'Media',
    mediaPlayer = process.env['MEDIA_PLAYER'] || null,
    mediaPattern = /\.(mp4|avi)$/,
    log,
    buffer = '',
    search,
    respond,
    respondJSON,
    types,
    sendFile,
    commands,
    handlers,
    player = null,
    stop,
    play,
    run,
    doLater = null,
    dummy;

log = function () {
    var str = util.format.apply(util, arguments);
    console.log('%s', str);
    buffer += '\n' + str;
}

search = function (base, subPath, filter) {
    var result = [],
        objs = fs.readdirSync(path.join(base, subPath));
    objs.sort();
    objs.reverse();
    objs.forEach(function (obj) {
        var stats,
            files;
        obj = path.join(subPath, obj);
        stats = fs.statSync(path.join(base, obj));
        if (stats.isFile()) {
            if (filter(obj)) {
                result.push(obj);
            }
        }
        else if (stats.isDirectory()) {
            files = search(base, obj, filter);
            result.push.apply(result, files);
        }
    });
    return result;
};

respond = function (response, code, type, body) {
    if (!response) {
        log('null response');
        return;
    }
    if (response.responded) {
        log('Already responded');
        return;
    }
    log(response.request.connection.remoteAddress + ' ' +
            response.request.url + ' ' + code + ' ' + type);
    if (code != 200) {
        log(body);
    }
    response.responded = true;
    response.writeHead(code, {'Content-Type': type});
    response.end(body);
};

respondJSON = function (response, obj) {
    respond(response, 200, 'application/json', util.format('%j', obj));
};

types = {
    'manifest': 'text/cache-manifest',
    'html': 'text/html',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'mp4': 'video/mp4',
    '': 'text/plain'
};

sendFile = function (response, name) {
    var stat, i, type, size, rs, code, match, options, headers;
    if (/\/\./.test(name) || name[0] !== '/') {
        throw new Error("Bad file");
    }
    name = path.join(wwwRoot, name.substr(1));
    stat = path.existsSync(name) && fs.statSync(name);
    if (stat && stat.isDirectory() && name[name.length - 1] !== '/') {
        name += '/';
    }
    if (name[name.length - 1] === '/') {
        name += 'index.html';
    }
    i = name.lastIndexOf('.');
    if (i < 0) {
        i = name.lastIndexOf('/');
    }
    type = name.substr(i + 1);
    if (!types.hasOwnProperty(type)) {
        throw new Error("Bad file type");
    }
    stat = path.existsSync(name) && fs.statSync(name);
    if (!stat || !stat.isFile()) {
        if (type === 'manifest') {
            i = name.lastIndexOf('/');
            respond(response, 200, types[type], util.format(
                    'CACHE MANIFEST\n# %s\n', 
                    fs.statSync(name.substr(0, i + 1) + 'index.html').mtime));
            return;
        }
        throw new Error("File not found");
    }
    size = stat.size;
    code = 200;
    options = undefined;
    headers = {'Content-type': types[type], 'Content-length': size};
    if (response.request.headers.hasOwnProperty('range')) {
        match = /bytes=(\d*)-(\d*)/.exec(response.request.headers.range);
        code = 206
        options = {start: 0, end: size - 1};
        if (match[1]) {
            options.start = parseInt(match[1]);
        }
        if (match[2]) {
            options.end = parseInt(match[2]);
        }
        headers['Content-length'] = options.end - options.start + 1;
        headers['Content-range'] =
            'bytes ' + options.start + '-' + options.end + '/' + size;
    } 
    rs = fs.createReadStream(name, options);
    response.writeHead(code, headers);
    log(response.request.connection.remoteAddress + ' ' +
            response.request.url + ' ' + code + ' ' +
            headers['Content-type'] + ' ' + headers['Content-length']);
    util.pump(rs, response, function (err) {
        if (err) {
            log(err.stack);
        }
    });
};

commands = {
    'increaseSpeed': '1',
    'decreaseSpeed': '2',
    'previousAudioStream': 'j',
    'nextAudioStream': 'k',
    'previousChapter': 'i',
    'nextChapter': 'o',
    'previousSubtitleStream': 'n',
    'nextSubtitleStream': 'm',
    'toggleSubtitles': 's',
    'exitOMXPlayer': 'q',
    'pauseOrResume': 'p',
    'decreaseVolume': '-',
    'increaseVolume': '+',
    'seekMinus30': '[D',
    'seekPlus30': '[C',
    'seekMinus600': '[B',
    'seekPlus600': '[A',
};

handlers = {
    '/log': function (response, query) {
        respond(response, 200, 'text/plain', buffer);
    },

    '/exit': function (response, query) {
        if (response && response.request.connection.remoteAddress !==
                '127.0.0.1') {
            throw new Error("Must be local");
        }
        respond(response, 200, 'text/plain', 'Bye, bye...');
        stop(function() {
            log("Exit...");
            process.exit();
        });
    },

    '/list': function (response, query) {
        var files = [];
        files.push.apply(files, search(wwwRoot, mediaDir, function (file) {
            return mediaPattern.test(file);
        }));
        respondJSON(response, files);
    },

    '/play': function (response, query) {
        stop(function () {
            require('child_process').exec('tvservice -o ; tvservice -p', 
                    function(error, stdout, stderr) {
                play(response, query);
            });
        });
    },

    '/control': function (response, query) {
        var command;
        if (!player) {
            throw new Error('Player is not running');
        }
        if (!query.hasOwnProperty('command')) {
            throw new Error('Missing command parameter');
        }
        command = query.command;
        if (!commands.hasOwnProperty(command)) {
            throw new Error('Bad command parameter');
        }
        player.stdin.write(commands[query.command]);
        respondJSON(response, null);
    }
};

stop = function (thenDo) {
    if (!player) {
        thenDo();
        return;
    }
    player.on('exit', function () {
        log('Stopped!');
        doLater(0, function () {
            thenDo();
        });
    });
    log('Stopping...');
    player.stdin.write('q');
};

play = function (response, query) {
    var file;
    if (!query.hasOwnProperty('file')) {
        throw new Error('Missing file parameter');
    }
    file = query.file;
    if (/\.\.(\/|$)/.test(file)) {
        throw new Error("Bad file");
    }
    file = path.join(wwwRoot, file);
    if (!path.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error("File not found");
    }
    log('Playing...');
    if (mediaPlayer) {
        log('Using: %s', mediaPlayer);
        player = require('child_process').spawn(mediaPlayer, [file]);
    }
    else {
        player = require('child_process').spawn('omxplayer',
                ['-o', 'hdmi', file]);
    }
    player.stdout.setEncoding('utf-8');
    player.stdout.on('data', function(data) {
        data = data.trim();
        if (data) {
            log('player: ' + data);
        }
    });
    player.on('exit', function () {
        log('Played!');
        player = null;
    });
    respondJSON(response, null);
};

run = function () {
    http.createServer(function (request, response) {
        var req = require('url').parse(request.url, true);
        response.request = request;
        doLater = function (delay, callback) {
            setTimeout(function () {
                try {
                    callback();
                }
                catch (e) {
                    respond(response, 500, 
                            'text/plain', util.format(
                                    'Failed to handle:\n%j\n%s',
                                    req, e.stack));
                }
            }, delay);
        };
        doLater(0, function () {
            if (!handlers.hasOwnProperty(req.pathname)) {
                sendFile(response, req.pathname);
                return;
            }
            handlers[req.pathname](response, req.query);
        });
    }).listen(port);
    log('Server running at port %d', port);
}

http.get({port: port, path: '/exit'}, function (res) {
    setTimeout(function () {
        log('Stopped...');
        run();
    }, 1000);
}).on('error', function (e) {
    log(e);
    run();
});

process.stdin.resume()
process.stdin.on('data', function (data) {
    log('data');
    handlers['/exit'](null, {});
});

