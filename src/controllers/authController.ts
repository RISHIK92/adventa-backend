import type { Request, Response } from "express";
import { prisma } from "../services/db.js";
import jwt from "jsonwebtoken";

export const Signup = async (req: Request, res: Response): Promise<void> => {
  const { email, uid } = req.user;
  console.log(uid);

  if (!email || !uid) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  try {
    if (existingUser) {
      res.status(400).json({ error: "User already exists" });
      return;
    }

    const newUser = await prisma.user.create({
      data: {
        id: uid,
        email,
      },
    });

    res
      .status(201)
      .json({ message: "User created successfully", user: newUser });
  } catch (error) {
    console.error("Signup Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const Signin = async (req: Request, res: Response): Promise<void> => {
  const { uid } = req.user;

  if (!uid) {
    res.status(400).json({ error: "Email is required" });
    return;
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: uid },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET || "123123");

    res.status(200).send({ token });
  } catch (error) {
    console.error("Login Error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
