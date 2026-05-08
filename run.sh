#!/bin/bash

# Configuration
PORT=6001
VENV_DIR="venv"
REQUIREMENTS_FILE="requirements.txt"

echo "🚀 Starting VisionAI Setup..."

# 1. Check for Virtual Environment
if [ ! -d "$VENV_DIR" ]; then
    echo "📦 Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

# 2. Activate Virtual Environment
echo "🔗 Activating virtual environment..."
source "$VENV_DIR/bin/activate"

# 3. Install Requirements
if [ -f "$REQUIREMENTS_FILE" ]; then
    echo "🛠 Checking/Installing requirements..."
    pip install -r "$REQUIREMENTS_FILE"
else
    echo "⚠️ requirements.txt not found!"
fi

# 4. Check if Port is Busy
echo "🔍 Checking port $PORT..."
PID=$(lsof -ti :$PORT)

if [ ! -z "$PID" ]; then
    echo "⛔ Port $PORT is busy (PID: $PID). Killing process..."
    kill -9 $PID
    sleep 1
    echo "✅ Process $PID killed."
else
    echo "✅ Port $PORT is free."
fi

# 5. Start the Server
echo "🔥 Starting the VisionAI server on port $PORT..."
python3 main.py
