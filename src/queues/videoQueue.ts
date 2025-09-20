import { Queue } from "bullmq";
import "dotenv/config";

const queueName = "video-generation";
const connection = {
  host: process.env.REDIS_HOST,
  port: parseInt(process.env.REDIS_PORT || "6379"),
};

export const videoQueue = new Queue(queueName, { connection });
console.log(`Queue "${queueName}" initialized.`);
