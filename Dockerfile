FROM node:18-slim

# Install Python
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies one by one (more reliable)
RUN pip3 install --no-cache-dir numpy --break-system-packages
RUN pip3 install --no-cache-dir scikit-learn --break-system-packages
RUN pip3 install --no-cache-dir huggingface_hub --break-system-packages
RUN pip3 install --no-cache-dir transformers --break-system-packages
RUN pip3 install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu --break-system-packages

# Set up app
WORKDIR /app
COPY . .
RUN npm install

EXPOSE 4000
CMD ["node", "server.js"]