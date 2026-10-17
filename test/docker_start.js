const test = require('tape').test ;
const exec = require('child_process').exec ;
const fs = require('fs-extra');

test('starting docker network..', (t) => {
  t.timeoutAfter(180000);

  // clear log and output directores
  fs.emptyDir(`${__dirname}/tmp/log`)
    .then(fs.emptyDir(`${__dirname}/tmp/rtpengine`))
    .catch((err) => {
      console.log(`Error cleaning tmp folders: ${err}`);
      t.end(err);
    });
  exec(`docker-compose -p test -f ${__dirname}/docker-compose-testbed.yaml up -d`, (err, stdout, stderr) => {
    if (-1 != stderr.indexOf('is up-to-date')) return t.end() ;
    console.log('docker network started, giving extra time for rtpengine to initialize...');
    setTimeout(() => {
      // 本环境只用 rtpengine 录音(不起 freeswitch),直接结束等待
      t.end() ;
    }, 8000);
  });
});

