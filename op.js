'use strict';

var http = require('http'),
    util = require('util'),
    fs = require('fs'),
    path = require('path'),
    port = (process.argv.length > 2 && parseInt(process.argv[2])) || 8124,
    mediaDir = process.env['MEDIA_DIR'] || 'Media',
    mediaPlayer = process.env['MEDIA_PLAYER'] || null,
    media_pattern = /\.(mp4|avi)$/,
    search,
    respond,
    respondJSON,
    sendFile,
    commands,
    handlers,
    player = null,
    play,
    stop,
    doLater = null,
    dummy;

search = function (base, subPath, filter) {
    var result = [];
    fs.readdirSync(path.join(base, subPath)).forEach(function (obj) {
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
        console.log('null response');
        return;
    }
    if (response.responded) {
        console.log('Already responded');
        return;
    }
    console.log(code + ' ' + type);
    response.responded = true;
    response.writeHead(code, {'Content-Type': type});
    response.end(body);
};

respondJSON = function (response, obj) {
    respond(response, 200, 'application/json', util.format('%j', obj));
};

sendFile = function (response, name, type) {
    if (/\.\.(\/|$)/.test(name)) {
        throw new Error("Bad file");
    }
    if (!path.existsSync(name) || !fs.statSync(name).isFile()) {
        throw new Error("File not found");
    }
    fs.readFile(name, function (err, data) {
        if (err) {
            console.log(err.stack);
        }
        respond(response, 200, type, data);
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
    '/': function (response, query) {
        sendFile(response, 'index.html', 'text/html');
    },

    '/favicon.ico': function (response, query) {
        sendFile(response, 'touch-icon.png', 'image/png');
    },

    '/svg': function (response, query) {
        sendFile(response, query.name + '.svg', 'image/svg+xml');
    },

    '/png': function (response, query) {
        sendFile(response, query.name + '.png', 'image/png');
    },

    '/exit': function (response, query) {
        respond(response, 200, 'text/plain', 'Bye, bye...');
        stop(function() {
            console.log("Exit...");
            process.exit();
        });
    },

    '/list': function (response, query) {
        var files = [];
        files.push.apply(files, search(mediaDir, '', function (file) {
            return media_pattern.test(file);
        }));
        respondJSON(response, files);
    },

    '/play': function (response, query) {
        stop(function () {
            play(response, query);
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
        console.log('Stopped!');
        doLater(0, function () {
            thenDo();
        });
    });
    console.log('Stopping...');
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
    file = path.join(mediaDir, file);
    if (!path.existsSync(file) || !fs.statSync(file).isFile()) {
        throw new Error("File not found");
    }
    console.log('Playing...');
    if (mediaPlayer) {
        console.log('Using: %s', mediaPlayer);
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
            console.log('player: ' + data);
        }
    });
    player.on('exit', function () {
        console.log('Played!');
        player = null;
    });
    respondJSON(response, null);
};

http.createServer(function (request, response) {
    var req = require('url').parse(request.url, true);
    console.log(request.url);
    doLater = function (delay, callback) {
        setTimeout(function () {
            try {
                callback();
            }
            catch (e) {
                respond(response, 500, 
                        'text/plain', util.format('Failed to handle:\n%j\n%s',
                                req, e.stack));
            }
        }, delay);

    };
    doLater(0, function () {
        handlers[req.pathname](response, req.query);
    });
}).listen(port);

console.log('Server running at http://127.0.0.1:%d/', port);
process.stdin.resume()
process.stdin.on('data', function (data) {
    console.log('data');
    handlers['/exit'](null, {});
});

