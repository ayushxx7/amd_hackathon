#!/bin/bash

PORT=6001
VENV_DIR="venv"

echo "Starting KiranaAI setup..."

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "$VENV_DIR"
fi

echo "Activating virtual environment..."
source "$VENV_DIR/bin/activate"

# Install PyTorch CPU-only first (avoids a 2 GB CUDA download)
if ! python3 -c "import torch" 2>/dev/null; then
    echo "Installing PyTorch (CPU)..."
    pip install torch --index-url https://download.pytorch.org/whl/cpu
fi

echo "Checking/installing remaining requirements..."
pip install -r requirements.txt

echo "Checking port $PORT..."
PID=$(lsof -ti :$PORT)
if [ -n "$PID" ]; then
    echo "Port $PORT busy (PID: $PID). Killing..."
    kill -9 $PID
    sleep 1
fi

echo "Starting KiranaAI server on port $PORT..."
python3 main.py
