var util = require('util')
  , events = require('events')
  , net = require('net')
  , async = require('async')
  , socket = new net.Socket();

/**
 * Define a constructor (object) and inherit EventEmitter functions
 */
function telnet() {
  events.EventEmitter.call(this);
  this.setTelnetState('init');

  // setup the queue for commands being sent, only allowing 1 at a time
  this.queue = async.queue(function(task, callback) {
    task(callback);
  }, 1);
}

util.inherits(telnet, events.EventEmitter);

/**
 * Define the default options for the module
 *
 * @type  object
 */
telnet.prototype.options = {
  host: '127.0.0.1',
  port: 23,
  timeout: 1000,
  shellPrompt: /(?:\/ )?#\s/,
  irs: '\r\n',
  ors: '\n',
  echoLines: 1,
  separator: '\n',
  execTimeout: false,
  debug: false
}

telnet.prototype.response = [];

/**
 * Create the connection to the telnet server
 *
 * @param   object  options
 */
telnet.prototype.connect = function(options) {
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

    this.queue.drain = function() {
      log('All commands have been sent');
    }
  }

  this.setTelnetState('connecting');

  this.telnetSocket = net.createConnection({
    port: this.port,
    host: this.host
  }, function() {
    if(self.debug) {
      log('Successfully connected');
    }

    self.setTelnetState('connected');
    self.setTelnetState('ready'); // this will eventually be within parseData see #6
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
      log('Received:');
      log(data.toString());
      log(data);
    }

    self.parseData(data);
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
 * Send a command
 *
 * @param   string    cmd
 * @param   function  callback
 */
telnet.prototype.exec = function(cmd, callback) {
  var self = this;

  if(this.debug) {
    log('Queuing: ' + cmd);
  }

  this.queue.push(function(next) {
    if(self.debug) {
      log('Writing: ' + cmd);
    }

    if(self.telnetSocket.writable !== true) {
      if(self.debug) {
        log('Socket is not writable');
      }

      callback(new Error('Socket is not writable'));
      next();
      return;
    }

    self.telnetSocket.write(cmd + self.ors, function() {
      self.response = [];
      self.setTelnetState('response');
      self.emit('executed');

      if(self.execTimeout !== false) {
        if(self.debug) {
          log('Creating response timeout of ' + self.execTimeout + 'ms');
        }

        setTimeout(function() {
          self.emit('response');
          self.setTelnetState('ready');
        }, self.execTimeout);
      }

      self.on('response', function() {
        if(this.debug) {
          log('Response ready with:');
          log(this.response);
        }

        if(typeof callback !== 'function') {
          next();
          return;
        }

        var response = self.response;

        if (self.separator !== false) {
          response.join(self.separator);
        }

        callback(null, response);
      });
    });
  });
}

/**
 * Parse the data returned from the telnet object
 *
 * @param   buffer    data
 */
telnet.prototype.parseData = function(chunk) {
  if(chunk[0] === 255 && chunk[1] !== 255) {
    var negReturn = negotiate(this, chunk);

    if(negReturn == undefined) {
      return;
    }

    chunk = negReturn;
  }

  switch(this.getTelnetState()) {
    // some event occured on telnet
    case 'ready':
      this.emit('data', chunk);
      break;

    // we are expecting a reponse
    case 'response':
      this.parseResponse(chunk.toString());
      break;
  }
}

/**
 * Parse a response which are are expecting due to exec
 *
 * @param   data
 */
telnet.prototype.parseResponse = function(data) {
  var promptIndex = data.search(this.shellPrompt);
  var response;

  if(promptIndex === -1 && data.length !== 0) {
    return;
  }

  response = data.split(this.irs);

  if(this.echoLines === 1) {
    response.shift();
  }

  if(this.echoLines > 1) {
    response.splice(0, this.echoLines);
  }

  // remove trailing response
  response.pop();

  this.response = this.response.concat(response);

  // if we are not using a timeout for the response, we will emit that we have received it here
  if(this.execTimeout === false) {
    this.emit('response');
  }
}

/**
 * Change the telnet state
 *
 * @param   string    state
 */
telnet.prototype.setTelnetState = function(state) {
  if(this.debug) {
    log('Setting telnet state to: ' + state);
  }

  this.telnetState = state;
}

/**
 * Get the current telnet state
 *
 * @returns   string
 */
telnet.prototype.getTelnetState = function() {
  return this.telnetState;
}

/**
 * End the socket connection
 */
telnet.prototype.end = function() {
  this.telnetSocket.end();
}

/**
 * Destory the socket
 */
telnet.prototype.destroy = function() {
  this.telnetSocket.destroy();
}

/**
 * Basic logging function when in debug mode
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

/**
 *
 * @param   object    telnetObj
 * @param   string    chunk
 * @returns string
 */
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

module.exports = telnet;