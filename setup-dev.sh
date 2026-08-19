#!/bin/bash
# Exit immediately if a command exits with a non-zero status
set -e

echo "🚀 Step 1: Installing workspace dependencies..."
npm install

echo "🛠️ Step 2: Compiling core library and transport packages..."
npm run build

echo "🔍 Step 3: Running TypeScript compiler validation..."
npm run typecheck

echo "🧪 Step 4: Running integration and unit tests..."
npm run test -- --run

echo "✅ Setup complete! All systems operational, built, and tested."
