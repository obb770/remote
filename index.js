/*jshint node:true */
'use strict';

var util = require('util'),
    fs = require('fs'),
    path = require('path'),
    mediaDir = 'Media',
    mediaPlayer = process.env.MEDIA_PLAYER || null,
    mediaPattern = /\.(mp4|avi|mkv)$/,
    log,
    buffer = '',
    search,
    respondJSON,
    commands,
    player = null,
    stopping = {},
    stop,
    play;

log = function () {
    var str = util.format.apply(util, arguments);
    console.log('%s', str);
    buffer += '\n' + str;
};

search = function (base, subPath, filter) {
    var result = [],
        objs = fs.readdirSync(path.join(base, subPath));
    objs.sort();
    objs.reverse();
    objs.forEach(function (obj) {
        var stats,
            files;
        obj = path.join(subPath, obj);
        try {
            stats = fs.statSync(path.join(base, obj));
        }
        catch (e) {
            log('exception: ' + e.stack);
            return;
        }
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

respondJSON = function (response, obj) {
    response.start(200, 'application/json', {}, util.format('%j', obj));
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

exports.handlers = {
    'log': function (response) {
        response.start(200, 'text/plain', {}, buffer);
    },

    'list': function (response) {
        var files = [];
        files.push.apply(files, search(__dirname, mediaDir, function (file) {
            return mediaPattern.test(file);
        }));
        respondJSON(response, files);
    },

    'play': function (response, query) {
        stop(function () {
            require('child_process').exec('tvservice -o ; tvservice -p', 
                    function (/*error, stdout, stderr*/) {
                try {
                    play(response, query);
                }
                catch (e) {
                    log(e.stack);
                }
            });
        });
    },

    'control': function (response, query) {
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
    var pid;
    if (!player) {
        thenDo();
        return;
    }
    pid = player.pid;
    if (stopping.hasOwnProperty(pid.toString())) {
        log('Already stopping ' + pid);
        return;
    }
    stopping[pid.toString()] = true;
    player.on('exit', function () {
        delete stopping[pid.toString()];
        log('Stopped! ' + pid);
        try {
            thenDo();
        }
        catch (e) {
            log('exception: ' + e.stack);
        }
    });
    log('Stopping... ' + pid);
    player.stdin.write('q');
};

play = function (response, query) {
    var file,
        pid;
    if (!query.hasOwnProperty('file')) {
        throw new Error('Missing file parameter');
    }
    file = query.file;
    if (/\.\.(\/|$)/.test(file)) {
        throw new Error("Bad file");
    }
    file = path.join(__dirname, file);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
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
    pid = player.pid;
    log('... ' + pid);
    player.stdout.setEncoding('utf-8');
    player.stdout.on('data', function(data) {
        data = data.trim();
        if (data) {
            log('player: ' + data);
        }
    });
    player.stdout.on('error', function (e) {
        log(e.stack);
    });
    player.stderr.on('error', function (e) {
        log(e.stack);
    });
    player.stdin.on('error', function (e) {
        log(e.stack);
    });
    player.on('exit', function () {
        log('Played! ' + pid);
        player = null;
    });
    respondJSON(response, null);
};
