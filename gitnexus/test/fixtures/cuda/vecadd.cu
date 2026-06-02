#include "kernels.cuh"

// A CUDA kernel: the `__global__` qualifier and the `<<<grid, block>>>`
// launch syntax below are the constructs that tree-sitter-cpp cannot parse
// but tree-sitter-cuda handles natively.
__global__ void vectorAdd(const float* a, const float* b, float* out, int n) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    out[i] = square(a[i]) + b[i];
  }
}

__global__ void scaleKernel(float* data, int n, float factor) {
  int i = blockIdx.x * blockDim.x + threadIdx.x;
  if (i < n) {
    data[i] = data[i] * factor;
  }
}

// Host-side launcher exercising the CUDA kernel-launch grammar.
void launchVectorAdd(const float* a, const float* b, float* out, int n) {
  int threads = 256;
  int blocks = (n + threads - 1) / threads;
  vectorAdd<<<blocks, threads>>>(a, b, out, n);
}
