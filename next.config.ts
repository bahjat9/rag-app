import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The local embedding model runs in Node with native ONNX bindings: keep these out of the bundle.
  serverExternalPackages: ["@huggingface/transformers", "onnxruntime-node", "sharp"],
};

export default nextConfig;
