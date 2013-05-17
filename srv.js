// -*-  tab-width:4; c-basic-offset: 4; indent-tabs-mode: nil  -*-

// NOTE: NEVER re-attach OR trigger event handlers in a nextTick()
// function. ALWAYS do it in the same tick since there might be
// pending events and the semantics might need a sequential ordering
// on the delivery of these events (for example the 'connect' and the
// 'data' events need to come in the order they arrived).

var dns = require('dns');

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

/* Enumerates all the events on 'emitter' and returns them as a list
 * of strings.
 */
function getAllEvents(emitter) {
    return Object.keys(emitter._events || { }).filter(function(event) {
        return event !== 'maxListeners';
    });
}

/* This function removes all the event handlers for the event(s)
 * listen in 'events'. If 'events' in undefined, this function
 * enumerates all events on 'emitter' and removes them all. The return
 * value is a function which can be called to re-attach the removed
 * handlers.
 *
 * The only parameter that this returned function takes in a boolean
 * (true/false) which indicates whether existing handlers should be
 * removed (true) or kept (false) before re-attaching all the old
 * handlers. This applies for *all* events, not just events that will
 * be re-attached.
 *
 */
function removeListeners(emitter, events) {
    if (typeof events === 'undefined') {
        events = getAllEvents(emitter);
    } else if (typeof events === 'string') {
        events = [ events ];
    } else if (!(events instanceof Array)) {
        throw new Error("'events' must be either undefined, a string, or an array of events");
    }

    var _events = { };
    events.forEach(function(event) {
        var _l = emitter.listeners(event);
        // Make a private copy (in case emitter.listeners() returns a
        // cached copy).
        _events[event] = _l.concat([ ]);
        emitter.removeAllListeners(event);
    });

    return function(prev_listeners_fate) {
        var _keys = Object.keys(_events).concat(getAllEvents(emitter));
        var done = { };
        _keys.forEach(function(event) {
            if (!done.hasOwnProperty(event)) {
                done[event] = 1;
                var _cl = _events[event] || [ ];
                if (prev_listeners_fate == REMOVE_PREVIOUS_LISTENERS) {
                    emitter.removeAllListeners(event);
                }
                if (_cl.length > 0) {
                    if (!emitter._events[event]) {
                        emitter._events[event] = [ ];
                    } else if (!(emitter._events[event] instanceof Array)) {
                        emitter._events[event] = [ emitter._events[event] ];
                    }
                    // emitter._events[event] is now an array.
                    emitter._events[event] = emitter._events[event].concat(_cl);
                }
            }
        });
    };
}

// connection attempts to multiple addresses in a row
function tryConnect(socket, addrs, timeout) {
    // Save original listeners
    var _add_old_listeners = removeListeners(socket, [ 'connect', 'error', 'timeout' ]);

    var onConnect = function() {
        _add_old_listeners(REMOVE_PREVIOUS_LISTENERS);
        // done!
        socket.emit('connect');
    };

    var error;
    var onError = function(e) {
        if (!e) {
            socket.destroy();
        }
        error = e || new Error('Connection timed out');
        connectNext();
    };
    var connectNext = function() {
        var addr = addrs.shift();
        if (addr) {
            socket.setTimeout(timeout, function() { });
            socket.connect(addr.port, addr.name);
        }
        else {
            _add_old_listeners(true);
            socket.emit('error', error || new Error('No addresses to connect to'));
        }
    };

    // Add our listeners
    socket.addListener('connect', onConnect);
    socket.addListener('error', onError);
    socket.addListener('timeout', onError);
    connectNext();
}

exports.removeListeners = removeListeners;

// Emits either the 'connect' or the 'error; event on the 'socket'
// object passed in.
exports.connect = function(socket, services, domain, defaultPort, timeout) {
    timeout = timeout || 10000; // 10 sec timeout
    var tryServices;
    tryServices = function() {
        var service = services.shift();
        if (service) {
            resolveSrv(service + '.' + domain, function(error, addrs) {
                if (addrs) {
                    tryConnect(socket, addrs, timeout);
                }
                else {
                    tryServices();
                }
            });
        } else {
            resolveHost(domain, function(error, addrs) {
                if (addrs && addrs.length > 0) {
                    addrs = addrs.map(function(addr) {
                        return { name: addr,
                                 port: defaultPort };
                    });
                    tryConnect(socket, addrs, timeout);
                }
                else {
                    socket.emit('error', error || new Error('No addresses resolved for ' + domain));
                }
            });

        } // if (service)

    }; // tryServices()

    // We start the process in the next tick so that if anything happens
    // synchronously, then the event listeners that the user has added 
    // on the socket object after calling connect() are also handled
    // properly.
    process.nextTick(tryServices);
};
