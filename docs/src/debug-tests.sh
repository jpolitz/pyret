#! /usr/bin/env bash

tmpf=.pyret-log

for f in **/.examples-*.arr; do
  echo -n Trying $(head -1 $f | sed -e 's/^# //')
  pyret $f > $tmpf 2>&1
  if grep -q 'compilation errors' $tmpf; then
    echo " " FAILED!
    cat $f
    echo
    echo ---------------
    cat $tmpf
    echo
  else
    echo " " OK
  fi
done
