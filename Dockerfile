# Stage 1: Build the Vite application
FROM node:20-alpine AS builder
WORKDIR /app

# Copy dependency files first to leverage Docker cache
COPY package.json package-lock.json* ./

# Install project dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Build the Vite application (generates the /dist folder)
RUN npm run build

# Stage 2: Production Web Server (Nginx)
FROM nginx:alpine

# Configure Nginx to listen on port 8080 and support Single Page Application (SPA) routing
RUN echo 'server { \
    listen 8080; \
    location / { \
        root /usr/share/nginx/html; \
        index index.html index.htm; \
        try_files $uri $uri/ /index.html; \
    } \
}' > /etc/nginx/conf.d/default.conf

# Copy the compiled static files from the builder stage to Nginx
COPY --from=builder /app/dist /usr/share/nginx/html

# Expose port 8080 as required by Google Cloud Run
EXPOSE 8080

# Start Nginx in the foreground
CMD ["nginx", "-g", "daemon off;"]