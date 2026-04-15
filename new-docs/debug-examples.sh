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

echo ===============
echo Library functions without examples:
echo ---------------

i=0

for f in $(cat _functions.rkt); do
  echo -n $f " "
  i=$((i + 1))
  if test $i -eq 5; then echo; i=0; fi
done
if test $i -lt 5; then echo; fi
