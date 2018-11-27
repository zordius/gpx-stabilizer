#!/usr/bin/env node
const { promisify } = require('util')
const { writeFileSync } = require('fs')
const gpsUtil = require('gps-util')

const gpxParseFile = promisify(gpsUtil.gpxParseFile)
const toGPX = promisify(gpsUtil.toGPX)

const [ , myname, file ] = process.argv

// Usage
if (!file) {
  console.warn(`
Usage: ${myname} gpxfile
`)
  process.exit()
}

const thresholds = {
  speed: 1,        // minimal moving speed m/s
  time: 10,        // minimal time leap second
  points: 8,       // minimal points in a moving time slot
  ele: 20,         // ele 20M
  dist: 20,        // distance 20M or 72KM/s , ski
  roughWindow: 2,  // window size in seconds
  fineWindow: 30   // window size in seconds
}

const averageKey = (points, key) => points.reduce((sum, point) => sum + point[key], 0) / points.length

const addSecond = trackpoint => {
  trackpoint.second = (new Date(trackpoint.time)).getTime() / 1000
}

const addSeconds = trackpoints => trackpoints.forEach(trackpoint => addSecond(trackpoint))

const addSpeed = (prev, trackpoint) => {
  const dis = gpsUtil.getDistance(prev.lng, prev.lat, trackpoint.lng, trackpoint.lat)
  trackpoint.diff = dis
  if (trackpoint.speed === undefined) {
    const time = trackpoint.second - prev.second
    trackpoint.speed = time === 0 ? 0 : dis / time
  }
}

const getAvgPoint = points => {
  const avg = gpsUtil.getMidPoint(points)

  avg.ele = averageKey(points, 'ele')
  avg.second = averageKey(points, 'second')
  avg.time = new Date(avg.second * 1000)

  return avg
}

const movingWindowAvg = (trackpoints, windowSize) => {
  const movingWindow = []
  const result = []

  trackpoints.forEach((trackpoint) => {
    while (movingWindow.length && trackpoint.second - movingWindow[0].second > windowSize) {
      movingWindow.shift()
      if (movingWindow.length % 2) {
        const avg = getAvgPoint(movingWindow)
        result.push(avg)
      }
    }
    movingWindow.push(trackpoint)
    const avg = getAvgPoint(movingWindow)
    result.push(avg)
  })

  return result
}

const speedFilter = (trackpoints, speed, time, points) => {
  const result = []
  let prev = trackpoints[0]
  let isStop = false
  let startPoints = 0

  trackpoints.forEach(trackpoint => {
    addSpeed(prev, trackpoint)
    if (trackpoint.speed > speed && trackpoint.second - prev.second < time) {
      if (isStop) {
        isStop = false
        startPoints = 0
      }
      startPoints += 1
      result.push(trackpoint)
    } else {
      if (!isStop) {
        if (startPoints < points) {
          let I
          for (I = 0;I < startPoints;I++) {
            result.pop()
          }
        }
        isStop = true
      }
    }
    prev = trackpoint
  })
  return result
}

const timeSlots = (trackpoints, time) => {
  const result = []
  let prev = trackpoints[0]
  let start = prev.second

  trackpoints.forEach(trackpoint => {
    if (trackpoint.second - prev.second > time) {
      const duration = trackpoint.second - start
      if (duration > time) {
        result.push({
          start,
          duration,
          end: trackpoint.second
        })
      }
      start = trackpoint.second
    }
    prev = trackpoint
  })

  return result
}

const firstPassCalc = (trackpoints) => {
  addSeconds(trackpoints)
  console.warn('Generate rough average...')
  const avgTracksR = movingWindowAvg(trackpoints, thresholds.roughWindow)
  console.warn('Generate fine average...')
  const avgTracksF = movingWindowAvg(trackpoints, thresholds.fineWindow)
  console.warn('Generate speed filterd...')
  const movingTrack = speedFilter(avgTracksF, thresholds.speed, thresholds.time, thresholds.points)
  console.warn('Generate moving time slots...')
  const movingTime = timeSlots(movingTrack, thresholds.time)

  return {
    trackpoints,
    avgTracksR,
    avgTracksF,
    movingTrack,
    movingTime
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
  writeFileSync(`${file}.speed.gpx`, meta.movingTrackGPX)
}

gpxParseFile(file)
.then(firstPassCalc)
.then(generateGPX('avgTracksR'))
.then(generateGPX('avgTracksF'))
.then(generateGPX('movingTrack'))
.then(saveGpx)
