#!/usr/bin/env node
const { promisify } = require('util')
const { writeFileSync } = require('fs')
const gpsUtil = require('gps-util')
const Victor = require('victor')

const [ , myname, file ] = process.argv

const gpxParseFile = promisify(gpsUtil.gpxParseFile)
const toGPX = promisify(({ points, title }, callback) => gpsUtil.toGPX({ points }, callback, title))

// Usage
if (!file) {
  console.warn(`
Usage: ${myname} gpxfile
`)
  process.exit()
}

const thresholds = {
  minspeed: 0.8,   // minimal moving speed m/s
  maxspeed: 12,    // maximal avg moving speed m/s
  minrest: 300,    // minimal rest time in seconds
  leap: 10,        // minimal no signal leap second
  duration: 15,    // minimal moving duration seconds
  dropdur: 40,     // minimal seconds to detect distance
  moveUp: 5,       // minimal ele change as moving up
  moveUpDis: 200,  // minimal move up distance
  moveUpAng: 30,   // minimal move up angle change
  dropdis: 200,    // drop distance m
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
  const time = trackpoint.second - prev.second

  trackpoint.diff = dis
  trackpoint.eleDiff = trackpoint.ele - prev.ele
  trackpoint.eleSpeed = time === 0 ? 0 : trackpoint.eleDiff / time
  trackpoint.victor = new Victor(trackpoint.lng - prev.lng, trackpoint.lat - prev.lat)
  trackpoint.angle = trackpoint.victor.angleDeg()

  if (trackpoint.speed === undefined) {
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

const speedFilter = (trackpoints) => {
  const result = []
  let prev = trackpoints[0]

  trackpoints.forEach(trackpoint => {
    addSpeed(prev, trackpoint)
    if (trackpoint.speed > thresholds.minspeed && trackpoint.speed < thresholds.maxspeed && trackpoint.diff < thresholds.dropdis) {
      result.push(trackpoint)
    }
    prev = trackpoint
  })
  return result
}

const angleDiff = (a, b) => {
  const diff = Math.abs(a - b)
  return diff < 180 ? diff : 360 - diff
}

const timeSlots = (trackpoints) => {
  const result = []
  let prev = trackpoints[0]
  let startPoint = prev
  let minPoint = prev
  let maxPoint = prev

  trackpoints.forEach(trackpoint => {
    if (trackpoint.second - prev.second >= thresholds.leap) {
      const duration = prev.second - startPoint.second
      const distance = gpsUtil.getDistance(startPoint.lng, startPoint.lat, prev.lng, prev.lat)
      let valid = duration > thresholds.duration
      if (duration < thresholds.dropdur) {
        if (distance < thresholds.dis) {
          valid = false
        }
      }
      const minmaxa = (new Victor(maxPoint.lng - minPoint.lng, maxPoint.lat - minPoint.lat)).angleDeg()
      const startenda = (new Victor(prev.lng - startPoint.lng, prev.lat - startPoint.lat)).angleDeg()
      if (valid) {
        const moveUp = prev.ele - startPoint.ele > thresholds.moveUp && distance > thresholds.moveUpDis && angleDiff(minmaxa, startenda) < 90
        result.push({
          startPoint,
          distance,
          endPoint: prev,
          minPoint,
          maxPoint,
          moveUp,
          minmaxa,
          startenda,
          start: startPoint.second,
          duration,
          end: prev.second
        })
      }
      minPoint = trackpoint
      maxPoint = trackpoint
      startPoint = trackpoint
    }
    if (minPoint.ele > prev.ele) {
      minPoint = prev
    }
    if (maxPoint.ele < prev.ele) {
      maxPoint = prev
    }
    prev = trackpoint
  })

  return result
}

const timeFilter = (trackpoints, movingTime, moveUp) => {
  let timeIndex = 0

  return trackpoints.filter(trackpoint => {
    const timeslot = movingTime[timeIndex]
    if (!timeslot) {
      return false
    }
    if (timeslot.start <= trackpoint.second) {
      if (timeslot.end >= trackpoint.second) {
        if (moveUp) {
          return timeslot.moveUp && angleDiff(trackpoint.angle, timeslot.minmaxa) < thresholds.moveUpAng
        } else {
          return true
        }
      } else {
        timeIndex++
      }
    }
  })
}

const hybridTrack = (firstTrack, secondTrack) => {
  const result = []
  let prev = firstTrack[0]
  let index = 0
  while (secondTrack[index].second < prev.second) {
    result.push(secondTrack[index])
    index++
  }

  firstTrack.forEach(trackpoint => {
    if (trackpoint.second - prev.second > thresholds.leap) {
      while (secondTrack[index].second < prev.second) {
        index++
      }
      while (secondTrack[index].second < trackpoint.second) {
        result.push(secondTrack[index])
        index++
      }
    }
    result.push(trackpoint)
    prev = trackpoint
  })

  return result.concat(secondTrack.slice(index + 1))
}

const firstPassCalc = (trackpoints) => {
  addSeconds(trackpoints)
  console.warn('Generate rough average...')
  const avgTracksR = movingWindowAvg(trackpoints, thresholds.roughWindow)
  console.warn('Generate fine average...')
  const avgTracksF = movingWindowAvg(trackpoints, thresholds.fineWindow)
  console.warn('Generate speed filtered...')
  const avgTracksFT = speedFilter(avgTracksF)
  console.warn('Generate moving time slots...')
  const movingTime = timeSlots(avgTracksFT)
  console.warn('Generate move filtered...')
  const movingTrack = timeFilter(trackpoints, movingTime)
  console.warn('Generate moveUp filtered...')
  const moveUpTrack = timeFilter(avgTracksF, movingTime, true)
  console.warn('Generate move average filtered...')
  const movingTrackAVG = timeFilter(avgTracksR, movingTime)
  console.warn('Generate moveHybrid...')
  const moveHybridTrack = hybridTrack(moveUpTrack, movingTrackAVG)

  return {
    trackpoints,
    avgTracksR,
    avgTracksF,
    avgTracksFT,
    movingTrack,
    moveUpTrack,
    movingTrackAVG,
    moveHybridTrack,
    movingTime
  }
}

const generateGPX = key => meta => {
  return toGPX({
    points: meta[key],
    title: `${file} - ${key}`
  })
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
  writeFileSync(`${file}.mov2.gpx`, meta.moveUpTrackGPX)
  writeFileSync(`${file}.mov3.gpx`, meta.moveHybridTrackGPX)
  console.warn('All GPX saved!')
}

gpxParseFile(file)
.then(firstPassCalc)
.then(generateGPX('avgTracksR'))
.then(generateGPX('avgTracksF'))
.then(generateGPX('avgTracksFT'))
.then(generateGPX('movingTrack'))
.then(generateGPX('moveUpTrack'))
.then(generateGPX('moveHybridTrack'))
.then(saveGpx)
