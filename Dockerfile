FROM node:18-slim

# Install Python
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt

# Set up app
WORKDIR /app
COPY . .
RUN npm install

EXPOSE 4000
CMD ["node", "server.js"]