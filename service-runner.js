#!/usr/bin/env node
'use strict';
require('./service').runForeground().catch((error) => {
  process.stderr.write(`BeAT 서비스 시작 실패: ${error.message}\n`);
  process.exitCode = 1;
});
