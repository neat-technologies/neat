import { connectToMongo } from './mongo'
import express from 'express'

export function start() {
  connectToMongo()
  return express()
}
