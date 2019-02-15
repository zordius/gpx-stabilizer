#!/usr/bin/env node
const { promisify } = require('util')
const { writeFileSync } = require('fs')
const gpsUtil = require('gps-util')
const Victor = require('victor')

const [ , myname, file ] = process.argv

const gpxParseFile = promisify(gpsUtil.gpxParseFile)
const toGPX = promisify(({ points, title }, callback) => gpsUtil.toGPX({ points }, callback, title))

const addSecond = trackpoint => {
  trackpoint.second = (new Date(trackpoint.time)).getTime() / 1000
  return trackpoint
}

const addSeconds = trackpoints => trackpoints.map(trackpoint => addSecond(trackpoint))

const filterGoproBadTime = trackpoints => {
  let prev = trackpoints[0]
  return trackpoints.filter(cur => {
    const OK = cur.time > prev.time && !((cur.lat === prev.lat) && (cur.lng === prev.lng))
    prev = cur
    return OK
  })
}

// Usage
if (!file) {
  console.warn(`
Usage: ${myname} gpxfile
`)
  process.exit()
}

gpxParseFile(file)
.then(addSeconds)
.then(filterGoproBadTime)
.then(trackpoints => toGPX({
  points: trackpoints,
  title: file
}))
.then(data => writeFileSync(`${file}.fixed.gpx`, data.replace(/(<\/*trkpt[^>]*>)/g, '\n$1\n')))
