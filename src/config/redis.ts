import { createClient, type RedisClientType } from "redis";

const redisClient: RedisClientType = createClient({
  url: process.env.REDIS_URL || "redis://:myStrongPassword@localhost:6379",
});

redisClient.on("connect", () => {
  console.log("✅ Connected to Redis");
});

redisClient.on("error", (err: any) => {
  console.error("❌ Redis Error:", err);
});

await redisClient.connect();

export { redisClient };
