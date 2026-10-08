import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.ANSHIN_BUILD_TARGET === "vps" ? "standalone" : undefined,
};

export default nextConfig;
