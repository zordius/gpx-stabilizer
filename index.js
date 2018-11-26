#!/usr/bin/env node
const { promisify } = require('util')
const gpsUtil = require('gps-util')
const gpxParseFile = promisify(gpsUtil.gpxParseFile)
const [ node, myname, file ] = process.argv

if (!file) {
  console.warn(`
Usage: ${myname} gpxfile
`)
  process.exit()
}
gpxParseFile(file).then(console.error)
