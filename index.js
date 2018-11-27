#!/usr/bin/env node
const { promisify } = require('util')
const { writeFileSync } = require('fs')
const gpsUtil = require('gps-util')

const gpxParseFile = promisify(gpsUtil.gpxParseFile)
const toGPX = promisify(gpsUtil.toGPX)

const [ node, myname, file ] = process.argv

// Usage
if (!file) {
  console.warn(`
Usage: ${myname} gpxfile
`)
  process.exit()
}

const thresholds = {
  speed: 0.08,     // less then 8 cm in one second
  ele: 20,         // ele 20M
  dist: 20,        // distance 20M or 72KM/s , ski
  roughWindow: 6,  // window size in seconds
  fineWindow: 30   // window size in seconds
}

const averageKey = (points, key) => points.reduce((sum, point) => sum + point[key], 0) / points.length

const addSecond = trackpoint => {
  trackpoint.second = (new Date(trackpoint.time)).getTime() / 1000
}

const addSeconds = trackpoints => trackpoints.forEach(trackpoint => addSecond(trackpoint))

const addSpeed = (prev, trackpoint) => {
  const dis = gpsUtil.getDistance(prev.lng, prev.lat, trackpoint.lng, trackpoint.lat)
  tracpoint.diff = dis
  if (trackpoint.speed === undefined) {
    const time = trackpoint.second - prev.second
    trackpoint.speed = time === 0 ? 0 : dis / time
  }
}

const movingWindowAvg = (trackpoints, windowSize) => {
  const movingWindow = []
  const result = []

  trackpoints.forEach((trackpoint) => {
    while (movingWindow.length && trackpoint.second - movingWindow[0].second > windowSize) {
      movingWindow.shift()
    }

    movingWindow.push(trackpoint)

    const avg = gpsUtil.getMidPoint(movingWindow)
    avg.ele = averageKey(movingWindow, 'ele')
    avg.second = averageKey(movingWindow, 'second')
    avg.time = new Date(avg.second * 1000)

    result.push(avg)
  })

  return result
}

const firstPassCalc = (trackpoints) => {
  addSeconds(trackpoints)
  console.warn('Generate rough average...')
  const avgTracksR = movingWindowAvg(trackpoints, thresholds.roughWindow)
  console.warn('Generate fine average...')
  const avgTracksF = movingWindowAvg(trackpoints, thresholds.fineWindow)

  return {
    trackpoints,
    avgTracksR,
    avgTracksF
  }
}

const generateGPX = key => meta => {
  return toGPX({points: meta[key]})
  .then(avgGpx => ({
    ...meta,
    [`${key}GPX`]: avgGpx
  }))
}

const saveGpx = (meta) => {
  writeFileSync(`${file}.avg1.gpx`, meta.avgTracksRGPX)
  writeFileSync(`${file}.avg2.gpx`, meta.avgTracksFGPX)
}

  /*
    avgPoint.avg = avg
    avgPoint.avgdiff = gpsUtil.getDistance(avg.lng, avg.lat, avgPoint.lng, avgPoint.lat)
    if (avgPoint.avgdiff > thresholds.dis || Math.abs(avgPoint.ele - avg.ele) > thresholds.ele) {
      avgPoint.invalid = true
    }
    prev = trackpoint
  })
  */

gpxParseFile(file)
.then(firstPassCalc)
.then(generateGPX('avgTracksR'))
.then(generateGPX('avgTracksF'))
.then(saveGpx)
