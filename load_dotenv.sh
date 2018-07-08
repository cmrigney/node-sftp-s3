#!/bin/bash

if [ $# -eq 0 ]; then
  echo "Pass in the command to run as an argument"
  exit 2
fi

if [ ! -f .env ]
then
  echo "Create your .env file first"
  exit 1
else
  export $(cat .env | sed '/^#/ d' | xargs)
  $1
fi