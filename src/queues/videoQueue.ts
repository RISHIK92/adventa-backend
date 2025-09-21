import { Queue } from "bullmq";
import "dotenv/config";

const queueName = "video-generation";
const connection = {
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD || "myStrongPassword",
};

export const videoQueue = new Queue(queueName, { connection });
console.log(`Queue "${queueName}" initialized.`);
