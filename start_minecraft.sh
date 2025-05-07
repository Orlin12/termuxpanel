#!/bin/bash
cd ~/minecraft-web-panel/minecraft
cpulimit -l 100 -- java -Xmx2G -jar server.jar nogui
