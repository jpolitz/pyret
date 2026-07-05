#! /usr/bin/env bash

for f in $(find . -type f -name \*.poly.pm); do
  echo "*****************************************************"
  if (echo $f|grep -q postlude.poly.pm); then 
    continue
  fi
  g=../docs/src/$f
  g_orig=$(echo $g|sed -e 's/\.poly\.pm$/.scrbl/')
  if test ! -f $g_orig; then
    g_orig=$(echo $g|sed -e 's/\.poly\.pm$/.js.rkt/')
  fi
  if test -f $g_orig; then
    diff $g_orig $f
  else
    echo $g_orig missing for $f
  fi
done
