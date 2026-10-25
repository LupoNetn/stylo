import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL is not configured');
}

const adapter = new PrismaPg({ connectionString });
const prisma = new PrismaClient({ adapter });

const assets = [
  { id: 'BTC', name: 'Bitcoin', precision: 8 },
  { id: 'XAU', name: 'Gold Spot', precision: 4 },
  { id: 'USD', name: 'US Dollar', precision: 2 },
];

async function main() {
  for (const asset of assets) {
    await prisma.asset.upsert({
      where: { id: asset.id },
      update: {
        name: asset.name,
        precision: asset.precision,
      },
      create: asset,
    });
  }

  console.log(`Seeded ${assets.length} assets.`);
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
