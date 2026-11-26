#!/bin/bash
# QuanHeng-Bench 多平台 Docker 镜像构建脚本
#
# 使用方法：
#   ./build.sh [-v version] [-p platforms] [-o output_dir]
#
# 示例：
#   ./build.sh                          # 默认构建 amd64 + arm64
#   ./build.sh -v v1.0.0                # 指定版本
#   ./build.sh -p linux/amd64           # 只构建 amd64
#   ./build.sh -o ./dist                # 输出到指定目录

set -e

VERSION="latest"
PLATFORMS="linux/amd64,linux/arm64"
OUTPUT_DIR="."
BUILDER_NAME="multiarch-builder"

usage() {
  echo "Usage: $0 [-v version] [-p platforms] [-o output_dir]"
  echo "  -v version    Version tag (default: latest)"
  echo "  -p platforms  Comma-separated platforms (default: linux/amd64,linux/arm64)"
  echo "  -o output_dir Output directory for tar.gz files (default: current dir)"
  echo "Example: $0 -v v1.0.0 -o ./dist"
  exit 1
}

while getopts "v:p:o:" opt; do
  case $opt in
    v) VERSION="$OPTARG" ;;
    p) PLATFORMS="$OPTARG" ;;
    o) OUTPUT_DIR="$OPTARG" ;;
    *) usage ;;
  esac
done

mkdir -p "$OUTPUT_DIR"

# Check and set up docker buildx builder
if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  echo "Creating multiarch builder: $BUILDER_NAME"
  docker buildx create --name "$BUILDER_NAME" --use
else
  echo "Using existing builder: $BUILDER_NAME"
  docker buildx use "$BUILDER_NAME"
fi

# Ensure builder is running
docker buildx inspect --bootstrap

build_and_save() {
  local platform=$1
  local platform_name=$(echo "$platform" | cut -d'/' -f2)
  # Per-platform tag: both tarballs can be loaded on the same Docker host
  # without one overwriting the other.
  local image_tag="quanheng-bench:$VERSION-$platform_name"

  echo "========================"
  echo "Building for $platform"
  echo "  Image tag:  $image_tag"
  echo "========================"

  docker buildx build --builder "$BUILDER_NAME" \
    --platform "$platform" \
    -t "$image_tag" \
    -f Dockerfile . --load

  local tar_file="$OUTPUT_DIR/quanheng-bench-$VERSION-$platform_name.tar"
  echo "Saving image to $tar_file"
  docker save "$image_tag" -o "$tar_file"

  echo "Compressing to $tar_file.gz"
  gzip -f "$tar_file"

  # Cleanup is best-effort: a running container may still reference the image.
  docker rmi "$image_tag" >/dev/null 2>&1 || true

  echo "✅ Built and saved $platform"
}

IFS=',' read -ra PLATFORM_ARRAY <<< "$PLATFORMS"
for PLATFORM in "${PLATFORM_ARRAY[@]}"; do
  build_and_save "$PLATFORM"
done

echo ""
echo "========================================="
echo "Build complete!"
echo "Files in $OUTPUT_DIR:"
ls -la "$OUTPUT_DIR"/quanheng-bench-$VERSION-*.tar.gz 2>/dev/null || echo "(no files)"
echo "========================================="
