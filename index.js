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
  minspeed: 1,     // minimal moving speed m/s
  maxspeed: 80,    // maximal moving speed m/s
  leap: 10,        // minimal no signal leap second
  duration: 15,    // minimal moving duration seconds
  dropdur: 40,     // minimal seconds to detect distance
  dropdis: 10,     // drop distance m
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

const boundingRadius = (trackpoints) => {
  const mid = gpsUtil.getMidPoint(trackpoints)
  return trackpoints.reduce((ret, trackpoint) => {
    const dis = gpsUtil.getDistance(trackpoint.lng, trackpoint.lat, mid.lng, mid.lat)
    return Math.max(ret, dis)
  }, 0)
}

const speedFilter = (trackpoints, thresholds) => {
  const result = []
  let prev = trackpoints[0]

  trackpoints.forEach(trackpoint => {
    addSpeed(prev, trackpoint)
    if (trackpoint.speed > thresholds.minspeed && trackpoint.speed < thresholds.maxspeed) {
      result.push(trackpoint)
    }
    prev = trackpoint
  })
  return result
}

const timeSlots = (trackpoints, thresholds) => {
  const result = []
  let prev = trackpoints[0]
  let startPoint = prev

  trackpoints.forEach(trackpoint => {
    if (trackpoint.second - prev.second >= thresholds.leap) {
      const duration = prev.second - startPoint.second
      const valid = duration > thresholds.duration
      if (duration < thresholds.dropdur) {
        const dis = gpsUtil.getDistance(startPoint.lng, startPoint.lat, prev.lng, prev.lat)
        if (dis < thresholds.dis) {
          valid = false
        }
      }
      if (valid) {
        result.push({
          start: startPoint.second,
          duration,
          end: prev.second
        })
      }
      startPoint = trackpoint
    }
    prev = trackpoint
  })

  return result
}

const timeFilter = (trackpoints, movingTime) => {
  let timeslot = movingTime.shift()

  return trackpoints.filter(trackpoint => {
    if (!timeslot) {
      return false
    }
    if (timeslot.start <= trackpoint.second) {
      if (timeslot.end >= trackpoint.second) {
        return true
      } else {
        timeslot = movingTime.shift()
      }
    }
  })
}

const firstPassCalc = (trackpoints) => {
  addSeconds(trackpoints)
  console.warn('Generate rough average...')
  const avgTracksR = movingWindowAvg(trackpoints, thresholds.roughWindow)
  console.warn('Generate fine average...')
  const avgTracksF = movingWindowAvg(trackpoints, thresholds.fineWindow)
  console.warn('Generate speed filtered...')
  const avgTracksFT = speedFilter(avgTracksF, thresholds)
  console.warn('Generate moving time slots...')
  const movingTime = timeSlots(avgTracksFT, thresholds)
  console.warn('Generate move filtered...')
  const movingTrack = timeFilter(trackpoints, movingTime)

  return {
    trackpoints,
    avgTracksR,
    avgTracksF,
    avgTracksFT,
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
  writeFileSync(`${file}.avg3.gpx`, meta.avgTracksFTGPX)
  writeFileSync(`${file}.mov1.gpx`, meta.movingTrackGPX)
  console.warn('All GPX saved!')
}

gpxParseFile(file)
.then(firstPassCalc)
.then(generateGPX('avgTracksR'))
.then(generateGPX('avgTracksF'))
.then(generateGPX('avgTracksFT'))
.then(generateGPX('movingTrack'))
.then(saveGpx)
