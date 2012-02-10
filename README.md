# dns-srv

A module to query SRV records from DNS servers

Usage: To query the *_xmpp-client._tcp* SRV record of *gmail.com*.

    var srv = require('dns-srv');
    var net = require('net');
    
    var sock = new net.Stream();
    srv.connect(sock // This socket will become connected if everything goes well
             , ['_xmpp-client._tcp'] // The SRV record to query
             , "gmail.com" // The domain whose DNS SRV we are interested in
             , 5222 // Default fallback port to connect to in case SRV lookup failed
    );

    sock.on('error', function() { console.error('meh...'); })
        .on('connect', function() { console.log('yeah baby!!'); });
