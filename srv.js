// -*-  tab-width:4; c-basic-offset: 4; indent-tabs-mode: nil  -*-

// NOTE: NEVER re-attach OR trigger event handlers in a nextTick()
// function. ALWAYS do it in the same tick since there might be
// pending events and the semantics might need a sequential ordering
// on the delivery of these events (for example the 'connect' and the
// 'data' events need to come in the order they arrived).

var dns    = require('dns');
var events = require('events');
var util   = require('util');

const REMOVE_PREVIOUS_LISTENERS = true;
const RETAIN_PREVIOUS_LISTENERS = false;

exports.REMOVE_PREVIOUS_LISTENERS = REMOVE_PREVIOUS_LISTENERS;
exports.RETAIN_PREVIOUS_LISTENERS = RETAIN_PREVIOUS_LISTENERS;

function compareNumbers(a, b) {
    a = parseInt(a, 10);
    b = parseInt(b, 10);
    return (a < b ? -1 : (a > b ? 1 : 0));
}

function once(proc) {
    var _fired = false;
    return function() {
        if (!_fired) {
            _fired = true;
            proc.apply(this, arguments);
        }
    };
}

// Sorts the SRV lookup results first by priority, then randomising the server
// order for a given priority. For discussion of handling of priority and
// weighting, see https://github.com/dhruvbird/dns-srv/pull/4
function groupSrvRecords(addrs) {
    var groups = {};  // by priority
    addrs.forEach(function(addr) {
        if (!groups.hasOwnProperty(addr.priority)) {
            groups[addr.priority] = [];
        }

        groups[addr.priority].push(addr);
    });

    var result = [];
    Object.keys(groups).sort(compareNumbers).forEach(function(priority) {
        var group = groups[priority];
        // Calculate the total weight for this priority group
        var totalWeight = 0;
        group.forEach(function(addr) {
            totalWeight += addr.weight;
        });
        while (group.length > 1) {
            // Select the next address (based on the relative weights)
            var w = Math.floor(Math.random() * totalWeight);
            var index = -1;
            while (++index < group.length && w > 0) {
                w -= group[index].weight;
            }
            if (index < group.length) {
                // Remove selected address from the group and add it to the
                // result list.
                var addr = group.splice(index, 1)[0];
                result.push(addr);
                // Adjust the total group weight accordingly
                totalWeight -= addr.weight;
            }
        }
        // Add the final address from this group
        result.push(group[0]);
    });
    return result;
}

// one of both A & AAAA, in case of broken tunnels
function resolveHost(name, cb) {
    var error, results = [];
    var cb1 = function(e, addr) {
        error = error || e;
        if (addr) {
            results.push(addr);
        }

        cb((results.length > 0) ? null : error, results);
    };

    dns.lookup(name, cb1);
}


function resolveSrv(name, cb) {
    dns.resolveSrv(name, function(err, addrs) {
        if (err) {
            /* no SRV record, try domain as A */
            cb(err);
        } else {
            var pending = 0, error, results = [];
            var cb1 = function(e, addrs1) {
                error = error || e;
                results = results.concat(addrs1);
                pending--;
                if (pending < 1) {
                    cb(results ? null : error, results);
                }
            };
            var gSRV = groupSrvRecords(addrs);
            pending = gSRV.length;
            gSRV.forEach(function(addr) {
                resolveHost(addr.name, function(e, a) {
                    if (a) {
                        a = a.map(function(a1) {
                            return {
                                name: a1,
                                port: addr.port
                            };
                        });
                    }
                    cb1(e, a);
                });
            });
        }
    });
}

function SrvConnector() {
}

util.inherits(SrvConnector, events.EventEmitter);

// Emits either the 'connect' or the 'error' event on the 'this'
// object.
SrvConnector.prototype.connect = function(socket, services, domain, defaultPort, timeout) {
    timeout = timeout || 10000; // 10 sec timeout
    var tryServices;
    tryServices = function() {
        var service = services.shift();
        if (service) {
            resolveSrv(service + '.' + domain, function(error, addrs) {
                if (addrs) {
                    this.tryConnect(socket, addrs, timeout);
                }
                else {
                    tryServices();
                }
            }.bind(this));
        } else {
            resolveHost(domain, function(error, addrs) {
                if (addrs && addrs.length > 0) {
                    addrs = addrs.map(function(addr) {
                        return { name: addr,
                                 port: defaultPort };
                    });
                    this.tryConnect(socket, addrs, timeout);
                }
                else {
                    this.emit('error', error || new Error('No addresses resolved for ' + domain));
                }
            }.bind(this));

        } // if (service)

    }.bind(this); // tryServices()

    // We start the process in the next tick so that if anything happens
    // synchronously, then the event listeners that the user has added 
    // on the socket object after calling connect() are also handled
    // properly.
    process.nextTick(tryServices);
};

// connection attempts to multiple addresses in a row
SrvConnector.prototype.tryConnect = function(socket, addrs, timeout) {
    var onConnect = function() {
        // done!
        socket.removeListener('connect', onConnect);
        socket.removeListener('error',   onError);
        socket.removeListener('timeout', onError);
        this.emit('connect');
    }.bind(this);

    var error;
    var onError = function(e) {
        if (!e) {
            socket.destroy();
        }
        error = e || new Error('Connection timed out');
        connectNext();
    }.bind(this);
    var connectNext = function() {
        var addr = addrs.shift();
        if (addr) {
            socket.setTimeout(timeout, function() { });
            socket.connect(addr.port, addr.name);
        }
        else {
            socket.removeListener('connect', onConnect);
            socket.removeListener('error',   onError);
            socket.removeListener('timeout', onError);
            this.emit('error', error || new Error('No addresses to connect to'));
        }
    }.bind(this);

    // Add our listeners
    socket.addListener('connect', onConnect);
    socket.addListener('error', onError);
    socket.addListener('timeout', onError);
    connectNext();
}

exports.connect = function(socket, services, domain, defaultPort, timeout) {
    var connector = new SrvConnector();
    process.nextTick(function() {
        connector.connect(socket, services, domain, defaultPort, timeout);
    });
    return connector;
}
