#!/bin/bash
set +e  # Continue on errors

COLOR_BLUE="\033[0;94m"
COLOR_GREEN="\033[0;92m"
COLOR_RESET="\033[0m"

# Print useful output for user
echo -e "${COLOR_BLUE}
     %########%      
     %###########%       ____                 _____                      
         %#########%    |  _ \   ___ __   __ / ___/  ____    ____   ____ ___ 
         %#########%    | | | | / _ \\\\\ \ / / \___ \ |  _ \  / _  | / __// _ \\
     %#############%    | |_| |(  __/ \ V /  ____) )| |_) )( (_| |( (__(  __/
     %#############%    |____/  \___|  \_/   \____/ |  __/  \__,_| \___\\\\\___|
 %###############%                                  |_|
 %###########%${COLOR_RESET}


Welcome to your development container!

This is how you can work with it:
- Files will be synchronized between your local machine and this container
- Some ports will be forwarded, so you can access this container via localhost
- The MCP server will start automatically in the background
- 
- If you need to restart it or run in foreground:
- - Run \`${COLOR_GREEN}pnpm dev${COLOR_RESET}\` to start the application in dev mode
- 
- For debugging:
- - Run \`${COLOR_GREEN}node --inspect=0.0.0.0:9229 dist/index.js --transport=sse${COLOR_RESET}\` to start the application in debug mode


"

# Set terminal prompt
export PS1="\[${COLOR_BLUE}\]devspace\[${COLOR_RESET}\] ./\W \[${COLOR_BLUE}\]\\$\[${COLOR_RESET}\] "
if [ -z "$BASH" ]; then export PS1="$ "; fi

# Include project's bin/ folder in PATH
export PATH="./bin:$PATH"

# Ensure dependencies are installed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    pnpm install
fi

# Build the project to ensure dist/ exists
if [ ! -d "dist" ]; then
    echo "Building project..."
    pnpm build
fi

# Start the server in the background so tools are available immediately
echo "Starting Google Cloud MCP server in background..."
pnpm dev > mcp-server.log 2>&1 &
echo "Server logs are being written to mcp-server.log"

# Open shell
bash --norc
