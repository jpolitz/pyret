import option as O

fun describe(x):
  cases(O.Option) x:
    | some(v) => "Got " + tostring(v)
    | none => "Nothing"
  end
end

print(describe(O.some(42)))
print(describe(O.none))
