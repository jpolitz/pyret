#! /usr/bin/env bash

echo ===============
echo Library functions without examples:
echo ---------------

i=0

for f in $(cat _untested-functions.rkt); do
  echo -n $f " "
  i=$((i + 1))
  if test $i -eq 5; then echo; i=0; fi
done
if test $i -lt 5; then echo; fi

n=$(for f in $(cat _untested-functions.rkt); do echo $f; done|wc -l)

echo ---------------
echo $n functions need testing
