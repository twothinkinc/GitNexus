#pragma once

// Device-side helper used by kernels in vecadd.cu.
__device__ float square(float x) {
  return x * x;
}

// Forward declaration of a kernel defined elsewhere.
__global__ void scaleKernel(float* data, int n, float factor);
