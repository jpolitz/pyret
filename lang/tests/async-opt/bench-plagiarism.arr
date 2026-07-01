provide *
import string-dict as SD

# Pure-CPU benchmark extracted from the Bootstrap "plagiarism-library" document-
# similarity engine (the docdiff-style cosine-similarity / angle-difference path).
# For each pair of documents it: tokenizes both (string-to-lower -> string-explode
# -> filter out punctuation -> fold characters back into words -> split on spaces),
# drops stop words (a `.member` scan over a ~180-word list per token), builds a
# bag-of-words frequency MutableStringDict, then computes the cosine of the angle
# between the two bag vectors (dot-product over the dict keys + num-sqrt) and turns
# it into an angle in degrees (num-acos). All the spreadsheet / Table / file-loading
# machinery is stripped; the corpus of short Wikipedia articles is inlined, and we
# run the all-pairs angle-difference comparison over it many times. Heavy on string
# explode/fold, MutableStringDict build + lookup, and List.member; nothing
# async-targeted. Output is deterministic for cont/promise parity.

lower-case-a-cp = string-to-code-point("a")
lower-case-z-cp = string-to-code-point("z")

fun is-non-punct(c :: String) -> Boolean:
  if (c == " ") or (c == "\n"): true
  else:
    c-cp = string-to-code-point(c)
    (c-cp >= lower-case-a-cp) and (c-cp <= lower-case-z-cp)
  end
end

fun is-non-empty-string(s :: String) -> Boolean: s <> "" end

fun massage-string(w :: String) -> String:
  fold(lam(string-a, string-b): string-a + string-b end, "",
    string-explode(string-to-lower(w)).filter(is-non-punct))
end

fun string-to-list-of-natlang-words(s :: String) -> List<String>:
  string-split-all(massage-string(string-to-lower(s)), " ").filter(is-non-empty-string)
end

standard-stop-words = [list: "the", "and", "a", "that", "was", "for", "with", "not", "on", "at", "i", "had", "are", "or", "an", "they", "one", "would", "all", "there", "their", "him", "has", "when", "if", "out", "what", "up", "about", "into", "can", "other", "some", "time", "two", "then", "do", "now", "such", "man", "our", "even", "made", "after", "many", "must", "years", "much", "your", "down", "should", "of", "to", "in", "is", "he", "it", "as", "his", "be", "by", "this", "but", "from", "have", "you", "which", "were", "her", "she", "will", "we", "been", "who", "more", "no", "so", "said", "its", "than", "them", "only", "new", "could", "these", "may", "first", "any", "my", "like", "over", "me", "most", "also", "did", "before", "through", "where", "back", "way", "well", "because", "each", "people", "state", "mr", "how", "make", "still", "own", "work", "long", "both", "under", "never", "same", "while", "last", "might", "day", "since", "come", "great", "three", "go", "few", "use", "without", "place", "old", "small", "home", "went", "once", "school", "every", "united", "number", "does", "away", "water", "fact", "though", "enough", "almost", "took", "night", "system", "general", "better", "why", "end", "find", "asked", "going", "knew", "toward", "just", "those", "too", "world", "very", "good", "see", "men", "here", "get", "between", "year", "another", "being", "life", "know", "us", "off", "against", "came", "right", "states", "take", "himself", "during", "again", "around", "however", "mrs", "thought", "part", "high", "upon", "say", "used", "war", "until", "always", "something", "public", "put", "think", "head", "far", "hand", "set", "nothing", "point", "house", "later", "eyes", "next", "program", "give", "white", "room", "social", "young", "present", "order", "second", "possible", "light", "face", "important", "among", "early", "need", "within", "business", "felt", "best", "ever", "least", "got", "mind", "want", "others", "although", "open", "area", "done", "certain", "door", "different", "sense", "help", "perhaps", "group", "side", "several", "let", "national", "given", "rather", "per", "often", "god", "things", "large", "big", "become", "case", "along", "four", "power", "saw", "less", "thing", "today", "interest", "turned", "members", "family", "problem", "kind", "began", "thus", "seemed", "whole", "itself"]

fun remove-stop-words(list-of-words :: List<String>) -> List<String>:
  list-of-words.filter(lam(w): not(standard-stop-words.member(w)) end)
end

fun list-of-words-to-sd(xx :: List<String>) -> SD.StringDict<Number> block:
  msd = [SD.mutable-string-dict: ]
  for each(x from xx):
    old-value = cases(Option) (msd.get-now(x)):
      | none => 0
      | some(v) => v
    end
    msd.set-now(x, old-value + 1)
  end
  msd.freeze()
end

fun dot-product(sd1 :: SD.StringDict<Number>, sd2 :: SD.StringDict<Number>) -> Number block:
  var n = 0
  for each(key from sd1.keys-list()) block:
    if sd2.has-key(key):
      n := n + (sd1.get-value(key) * sd2.get-value(key))
    else: false
    end
  end
  n
end

fun cosine-similarity-lists(words1 :: List<String>, words2 :: List<String>) -> Number:
  sd1 = list-of-words-to-sd(words1)
  sd2 = list-of-words-to-sd(words2)
  if sd1 == sd2: 1
  else if (sd1.count() == 0) or (sd2.count() == 0):
    raise("cosine-similarity is undefined when one arg is empty and the other isn't")
  else:
    dot-product(sd1, sd2) / (num-sqrt(dot-product(sd1, sd1)) * num-sqrt(dot-product(sd2, sd2)))
  end
end

fun angle-difference-lists(words1 :: List<String>, words2 :: List<String>) -> Number:
  cos-sim = cosine-similarity-lists(words1, words2)
  (num-acos(cos-sim) * 180) / 3.14159265
end

# Inlined corpus: short Wikipedia article excerpts (from plagiarism-library.arr).
badger = "The American badger is a North American badger similar in appearance to the European badger, although not closely related. It is found in the western, central, and northeastern United States, northern Mexico, and south-central Canada to certain areas of southwestern British Columbia. The American badger's habitat is typified by open grasslands with available prey (such as mice, squirrels, and groundhogs)."
bluewhale = "The blue whale is a marine mammal and a baleen whale. Reaching a maximum confirmed length of 29.9 m and weighing up to 199 tons, it is the largest animal known ever to have existed. The blue whale's long and slender body can be of various shades of greyish-blue on its upper surface and somewhat lighter underneath."
chimpanzee = "The chimpanzee lives in groups that range in size from 15 to 150 members, although individuals travel and forage in much smaller groups during the day. The species lives in a strict male-dominated hierarchy, where disputes are generally settled without the need for violence. Nearly all chimpanzee populations have been recorded using tools, modifying sticks, rocks, grass and leaves and using them for hunting and acquiring honey, termites, ants, nuts and water."
elephant = "The elephant has been a contributor to Thai society and its icon for many centuries. The elephant has had a considerable impact on Thai culture. The Thai elephant is the official national animal of Thailand. The elephant found in Thailand is the Indian elephant, a subspecies of the Asian elephant."
giraffe = "The giraffe's distinguishing characteristics are its extremely long neck and legs, horn-like ossicones, and spotted coat patterns. It is classified under the family Giraffidae, along with its closest extant relative, the okapi. Its scattered range extends from Chad in the north to South Africa in the south and from Niger in the west to Somalia in the east."
hamster = "Hamsters feed primarily on seeds, fruits, vegetation, and occasionally burrowing insects. In the wild, they are crepuscular: they forage during the twilight hours. In captivity, however, they are known to live a conventionally nocturnal lifestyle, waking around sundown to feed and exercise. Physically, they are stout-bodied with distinguishing features that include elongated cheek pouches extending to their shoulders, which they use to carry food back to their burrows, as well as a short tail and fur-covered feet."
manatee = "Manatees are herbivores and eat over 60 different freshwater and saltwater plants. Manatees inhabit the shallow, marshy coastal areas and rivers of the Caribbean Sea, the Gulf of Mexico, the Amazon basin, and West Africa. The main causes of death for manatees are human-related issues, such as habitat destruction and human objects."
polarbear = "The polar bear is a large bear native to the Arctic and nearby areas. It is closely related to the brown bear, and the two species can interbreed. The polar bear is the largest extant species of bear and land carnivore, with adult males weighing 300-800 kg. The polar bear is white- or yellowish-furred with black skin and a thick layer of fat."
rhino = "Rhinoceroses are some of the largest remaining megafauna: all weigh over half a tonne in adulthood. They have a herbivorous diet, small brains 400-600 g for mammals of their size, one or two horns, and a thick 1.5-5 cm, protective skin formed from layers of collagen positioned in a lattice structure. They generally eat leafy material."
snail = "Snails can be found in a very wide range of environments, including ditches, deserts, and the abyssal depths of the sea. Although land snails may be more familiar to laymen, marine snails constitute the majority of snail species, and have much greater diversity and a greater biomass. Numerous kinds of snail can also be found in fresh water."
okapi = "The okapi is classified under the family Giraffidae, along with its closest extant relative, the giraffe. Its distinguishing characteristics are its long neck, and large, flexible ears. Male okapis have horn-like protuberances called ossicones."

corpus = [list: badger, bluewhale, chimpanzee, elephant, giraffe, hamster, manatee, polarbear, rhino, snail, okapi]

# Tokenize + stop-word-strip each document once; the cosine path rebuilds the
# bag-of-words dicts on every comparison (the representative hot work).
cleaned-word-lists = corpus.map(lam(doc): remove-stop-words(string-to-list-of-natlang-words(doc)) end)

# all-pairs angle difference, summed as an integer checksum for stable parity
fun all-pairs-checksum() -> Number block:
  var total = 0
  n = cleaned-word-lists.length()
  for each(i from range(0, n)) block:
    wi = cleaned-word-lists.get(i)
    for each(j from range(i + 1, n)) block:
      angle = angle-difference-lists(wi, cleaned-word-lists.get(j))
      total := total + num-round(angle * 1000)
    end
  end
  total
end

fun run(iters :: Number, acc :: Number) -> Number:
  if iters <= 0: acc
  else: run(iters - 1, acc + all-pairs-checksum())
  end
end

t0 = time-now()
result = run(120, 0)
t1 = time-now()
print(num-to-string(result) + "\n")
print("LOOP-MS " + num-to-string(t1 - t0) + "\n")
