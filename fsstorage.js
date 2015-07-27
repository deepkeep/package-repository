
var fs = require('fs');
var path = require('path');
var express = require('express');

module.exports = FSStorage;

function FSStorage(app) {
  if (!fs.existsSync('storage')) fs.mkdirSync('storage');
  app.use('/storage', express.static('storage'));
}
FSStorage.prototype.exists = function(key) {
  return Promise.resolve(fs.existsSync(path.join('storage', key)));
}
FSStorage.prototype.upload = function(key, stream) {
  return new Promise(function(resolve, reject) {
    var f = fs.createWriteStream(path.join('storage', key));
    stream.pipe(f).on('close', function() {
      resolve();
    });
  });
}
FSStorage.prototype.listPrefix = function(prefixKey) {
  var l = fs.readdirSync('storage');
  return Promise.resolve(
    l.filter(function(x) { return x.indexOf(prefixKey) == 0; })
     .map(function(x) { return { key: x }})
  );
}
FSStorage.prototype.urlForKey = function(key) {
  return '/storage/' + encodeURIComponent(key);
}
