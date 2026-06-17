import string-dict as SD

check:
  "hello".length() is 5
  string-substring("hello", 0, 3) is "hel"
  string-to-upper("hello") is "HELLO"
  string-split("a,b,c", ",") is [list: "a", "b", "c"]
end

print("done")
