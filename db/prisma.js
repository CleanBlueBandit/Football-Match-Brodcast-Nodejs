const { PrismaClient, Prisma } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const pool = require('./pool');

// One PrismaClient for the whole app, backed by the shared pg pool.
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

module.exports = { prisma, Prisma, pool };
