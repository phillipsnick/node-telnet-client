var util = require('util');
var events = require('events');
var net = require('net');
var socket = new net.Socket();

/**
 * Define a constructor (object) and inherit EventEmitter functions
 */
function Telnet() {
  events.EventEmitter.call(this);

  if(false === (this instanceof Telnet)) {
    return new Telnet();
  }
}

util.inherits(Telnet, events.EventEmitter);

/**
 * Define the default options for the module
 *
 * @type  object
 */
Telnet.prototype.options = {
  host: '127.0.0.1',
  port: 23,
  timeout: 1000,
  shellPrompt: /(?:\/ )?#\s/,
  loginPrompt: /login[: ]*$/i,
  passwordPrompt: /Password: /i,
  username: 'root',
  password: 'guest',
  irs: '\r\n',
  ors: '\n',
  echoLines: 1,
  seperator: '\n',
  debug: false
}

/**
 * Create the connection to the telnet server
 *
 * @param   object  options
 */
Telnet.prototype.connect = function(options) {
  var self = this;

  // first apply the default options
  for(var key in this.options) {
    this[key] = this.options[key];
  }

  // now apply any custom options
  for(var key in options) {
    this[key] = options[key];
  }

  if(this.debug) {
    log('Attempting to connect to telnet server ' + this.host + ' on port ' + this.port);
  }

  this.response = '';
  this.telnetState;

  this.telnetSocket = net.createConnection({
    port: this.port,
    host: this.host
  }, function() {
    if(self.debug) {
      log('Successfully connected');
    }

    self.telnetState = 'start';
    self.stringData = '';
    self.emit('connect');
  });

  this.telnetSocket.setTimeout(this.timeout, function() {
    if(self.telnetSocket._connecting === true) {
      // info: cannot connect; emit error and destroy
      self.emit('error', 'Cannot connect');

      self.telnetSocket.destroy();

      if(self.debug) {
        log('Unable to connect');
      }
    }
    else {
      self.emit('timeout');

      if(self.debug) {
        log('Connection timeout');
      }
    }
  });

  this.telnetSocket.on('data', function(data) {
    if(self.debug) {
      log('Received: ' + data.toString());
    }

    parseData(data, self);
  });

  this.telnetSocket.on('error', function(error) {
    if(self.debug) {
      log('Error: ' + error);
    }

    self.emit('error', error);
  });

  this.telnetSocket.on('end', function() {
    if(self.debug) {
      log('Connection ended');
    }

    self.emit('end');
  });

  this.telnetSocket.on('close', function() {
    if(self.debug) {
      log('Connection closed');
    }

    self.emit('close');
  });
}

/**
 * Send a command via the current connection
 *
 * @param   string    cmd
 * @param   function  callback
 */
Telnet.prototype.exec = function(cmd, callback) {
  var self = this;

  if(this.telnetSocket.writable !== true) {
    if(self.debug) {
      log('Socket is not writable');
    }

    return;
  }

  if(self.debug) {
    log('Writing: ' + cmd);
  }

  this.telnetSocket.write(cmd + this.ors, function() {
    self.setTelnetState('response');
    self.emit('writedone');

    self.on('responseready', function() {
      self.stringData = '';

      if(typeof callback !== 'function') {
        return;
      }

      if (typeof self.cmdOutput === 'undefined') {
        callback();
        return;
      }

      var response = self.cmdOutput;

      if(self.seperator) {
        var response = response.join(self.seperator);
      }

      callback(response);
    });
  });
}

/**
 * Change the telnet state
 *
 * @param   string    state
 */
Telnet.prototype.setTelnetState = function(state) {
  if(this.debug) {
    log('Setting telnet state to: ' + state);
  }

  this.telnetState = state;
}

/**
 * End the socket connection
 */
Telnet.prototype.end = function() {
  this.telnetSocket.end();
}

/**
 * Destory the socket
 */
Telnet.prototype.destroy = function() {
  this.telnetSocket.destroy();
}

function parseData(chunk, telnetObj) {
  var promptIndex = '';

  if(chunk[0] === 255 && chunk[1] !== 255) {
    telnetObj.stringData = '';
    var negReturn = negotiate(telnetObj, chunk);

    if(negReturn == undefined) {
      return;
    }

    chunk = negReturn;
  }

  if(telnetObj.telnetState === 'start') {
    telnetObj.telnetState = 'getprompt';
  }

  if(telnetObj.telnetState === 'getprompt') {
    var stringData = chunk.toString();
    var promptIndex = stringData.search(telnetObj.shellPrompt);

    if(promptIndex !== -1) {
      telnetObj.shellPrompt = stringData.substring(promptIndex);
      telnetObj.telnetState = 'sendcmd';
      telnetObj.stringData = '';
      telnetObj.emit('ready', telnetObj.shellPrompt);
    }
    else if(stringData.search(telnetObj.loginPrompt) !== -1) {
      telnetObj.telnetState = 'login';
      login(telnetObj, 'username');
    }
    else if(stringData.search(telnetObj.passwordPrompt) !== -1) {
      telnetObj.telnetState = 'login';
      login(telnetObj, 'password');
    }

    return;
  }

  if(telnetObj.telnetState === 'response') {
    var stringData = chunk.toString();
    telnetObj.stringData += stringData;
    promptIndex = stringData.search(telnetObj.shellPrompt);

    if(promptIndex === -1 && stringData.length !== 0) {
      return;
    }

    telnetObj.cmdOutput = telnetObj.stringData.split(telnetObj.irs);

    if(telnetObj.echoLines === 1) {
      telnetObj.cmdOutput.shift();
    }
    else if(telnetObj.echoLines > 1) {
      telnetObj.cmdOutput.splice(0, telnetObj.echoLines);
    }

    // remove prompt
    telnetObj.cmdOutput.pop();

    telnetObj.emit('responseready');

    return;
  }

  telnetObj.emit('data', chunk);
}

function login(telnetObj, handle) {
  if(handle === 'username') {
    if(telnetObj.telnetSocket.writable) {
      telnetObj.telnetSocket.write(telnetObj.username + telnetObj.ors, function() {
        telnetObj.telnetState = 'getprompt';
      });
    }
  }
  else if(handle === 'password') {
    if(telnetObj.telnetSocket.writable) {
      telnetObj.telnetSocket.write(telnetObj.password + telnetObj.ors, function() {
        telnetObj.telnetState = 'getprompt';
      });
    }
  }
}

function negotiate(telnetObj, chunk) {
  // info: http://tools.ietf.org/html/rfc1143#section-7
  // refuse to start performing and ack the start of performance
  // DO -> WONT; WILL -> DO
  var packetLength = chunk.length, negData = chunk, cmdData, negResp;

  for(var i = 0; i < packetLength; i += 3) {
    if(chunk[i] != 255) {
      negData = chunk.slice(0, i);
      cmdData = chunk.slice(i);
      break;
    }
  }

  negResp = negData.toString('hex').replace(/fd/g, 'fc').replace(/fb/g, 'fd');

  if(telnetObj.telnetSocket.writable) {
    telnetObj.telnetSocket.write(Buffer(negResp, 'hex'));
  }

  if(cmdData != undefined) {
    return cmdData;
  }
}

/**
 * Logging function when in debug mode
 *
 * @param   string  message
 */
function log(message) {
  var date = new Date();
  var dateStr = date.getDate() + '/';
  dateStr += (date.getMonth() + 1) + '/';
  dateStr += (date.getFullYear()) + ' ';
  dateStr += date.getHours() + ':';
  dateStr += date.getMinutes() + ':';
  dateStr += date.getSeconds();

  console.log(dateStr, message);
}

module.exports = Telnet;