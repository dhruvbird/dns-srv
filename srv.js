var dns = require('dns');

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
        var totalWeight = 0;
        group.forEach(function(addr) {
            totalWeight += addr.weight;
        });
        var w = Math.floor(Math.random() * totalWeight);
        totalWeight = 0;
        var candidate = group[0];
        group.forEach(function(addr) {
            totalWeight += addr.weight;
            if (w < totalWeight) {
                candidate = addr;
	    }
        });
        if (candidate) {
            result.push(candidate);
	}
    });
    return result;
}

// one of both A & AAAA, in case of broken tunnels
function resolveHost(name, cb) {
    // console.error("resolveHost::", new Error().stack.toString());
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

function getAllEvents(emitter) {
    return Object.keys(emitter._events || { }).filter(function(event) {
	return event !== 'maxListeners';
    });
}



function removeListeners(emitter, events) {

    if (typeof events === 'undefined') {
	events = getAllEvents(emitter);
    }
    else if (typeof events === 'string') {
	events = [ events ];
    }
    else if (!(events instanceof Array)) {
	throw new Error("'events' must be either undefined, a string, or an array of events");
    }

    var _events = { };
    events.forEach(function(event) {
	var _l = emitter.listeners(event);
	_events[event] = _l.splice(0, _l.length);
    });

    return function(remove_prev_listeners) {
	var _keys = Object.keys(_events).concat(getAllEvents(emitter));
	var done = { };
	_keys.forEach(function(event) {
	    if (!done.hasOwnProperty(event)) {
		done[event] = 1;
		var _cl = _events[event] || [ ];
		_cl.unshift(0, 0);
		if (remove_prev_listeners) {
		    emitter.removeAllListeners(event);
		}
		var _l = emitter.listeners(event);
		_l.splice.apply(_l, _cl);
	    }
	});
    };
}


// connection attempts to multiple addresses in a row
function tryConnect(socket, addrs, timeout) {
    // console.error("tryConnect::", new Error().stack.toString());

    // Save original listeners
    var _add_old_listeners = removeListeners(socket);

    var onConnect = function() {
	// console.error('srv.js::connected!!');
	_add_old_listeners(true);

        // done!
        socket.emit('connect');
    };

    var error;
    var onError = function(e) {
	// console.error("srv.js::onError, e:", e, addrs);
	if (!e) {
	    socket.destroy();
	}
	error = e || new Error('Connection timed out');
	connectNext();
    };
    var connectNext = function() {
	// console.error("srv.js::addrs:", addrs);
        var addr = addrs.shift();
        if (addr) {
	    socket.setTimeout(timeout, function() { });
            socket.connect(addr.port, addr.name);
	}
        else {
	    // console.error("Emitting ERROR in srv.js");
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


// returns EventEmitter with 'connect' & 'error'
exports.connect = function(socket, services, domain, defaultPort, timeout) {
    // console.error("connect:services", services);

    timeout = timeout || 10000; // 10 sec timeout
    var tryServices;
    tryServices = function() {
        var service = services.shift();
        if (service) {
	    // console.error("Trying to resolve SRV");
            resolveSrv(service + '.' + domain, function(error, addrs) {
                if (addrs) {
                    tryConnect(socket, addrs, timeout);
		}
                else {
                    tryServices();
		}
            });
        } else {
	    // console.error("Trying to resolve host");
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
