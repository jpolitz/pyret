#!/usr/bin/env python3
# Faithful Python port of bench-plagiarism.arr (see that file for the description).
# Timing mirrors the Pyret harness: only the driver loop is bracketed, and it
# prints a deterministic checksum line + "LOOP-MS <ms>". Tokenization + stop-word
# stripping happen once at module load (as in the .arr, they are NOT in the timed
# loop); the hot work is rebuilding the bag-of-words dicts + dot-products per pair.
import math, time

LOWER_A = ord("a")
LOWER_Z = ord("z")

def is_non_punct(c):
    if c == " " or c == "\n":
        return True
    cp = ord(c)
    return LOWER_A <= cp <= LOWER_Z

def massage_string(w):
    # explode -> filter non-punct -> fold back to string
    return "".join(c for c in w.lower() if is_non_punct(c))

def string_to_list_of_natlang_words(s):
    return [w for w in massage_string(s.lower()).split(" ") if w != ""]

standard_stop_words = ["the", "and", "a", "that", "was", "for", "with", "not", "on", "at", "i", "had", "are", "or", "an", "they", "one", "would", "all", "there", "their", "him", "has", "when", "if", "out", "what", "up", "about", "into", "can", "other", "some", "time", "two", "then", "do", "now", "such", "man", "our", "even", "made", "after", "many", "must", "years", "much", "your", "down", "should", "of", "to", "in", "is", "he", "it", "as", "his", "be", "by", "this", "but", "from", "have", "you", "which", "were", "her", "she", "will", "we", "been", "who", "more", "no", "so", "said", "its", "than", "them", "only", "new", "could", "these", "may", "first", "any", "my", "like", "over", "me", "most", "also", "did", "before", "through", "where", "back", "way", "well", "because", "each", "people", "state", "mr", "how", "make", "still", "own", "work", "long", "both", "under", "never", "same", "while", "last", "might", "day", "since", "come", "great", "three", "go", "few", "use", "without", "place", "old", "small", "home", "went", "once", "school", "every", "united", "number", "does", "away", "water", "fact", "though", "enough", "almost", "took", "night", "system", "general", "better", "why", "end", "find", "asked", "going", "knew", "toward", "just", "those", "too", "world", "very", "good", "see", "men", "here", "get", "between", "year", "another", "being", "life", "know", "us", "off", "against", "came", "right", "states", "take", "himself", "during", "again", "around", "however", "mrs", "thought", "part", "high", "upon", "say", "used", "war", "until", "always", "something", "public", "put", "think", "head", "far", "hand", "set", "nothing", "point", "house", "later", "eyes", "next", "program", "give", "white", "room", "social", "young", "present", "order", "second", "possible", "light", "face", "important", "among", "early", "need", "within", "business", "felt", "best", "ever", "least", "got", "mind", "want", "others", "although", "open", "area", "done", "certain", "door", "different", "sense", "help", "perhaps", "group", "side", "several", "let", "national", "given", "rather", "per", "often", "god", "things", "large", "big", "become", "case", "along", "four", "power", "saw", "less", "thing", "today", "interest", "turned", "members", "family", "problem", "kind", "began", "thus", "seemed", "whole", "itself"]

def remove_stop_words(words):
    # linear .member scan over the stop list, faithful to the .arr
    return [w for w in words if w not in standard_stop_words]

def list_of_words_to_sd(xx):
    msd = {}
    for x in xx:
        msd[x] = msd.get(x, 0) + 1
    return msd

def dot_product(sd1, sd2):
    n = 0
    for key in sd1:
        if key in sd2:
            n = n + (sd1[key] * sd2[key])
    return n

def cosine_similarity_lists(words1, words2):
    sd1 = list_of_words_to_sd(words1)
    sd2 = list_of_words_to_sd(words2)
    if sd1 == sd2:
        return 1
    elif len(sd1) == 0 or len(sd2) == 0:
        raise ValueError("cosine-similarity is undefined when one arg is empty and the other isn't")
    else:
        return dot_product(sd1, sd2) / (math.sqrt(dot_product(sd1, sd1)) * math.sqrt(dot_product(sd2, sd2)))

def angle_difference_lists(words1, words2):
    cos_sim = cosine_similarity_lists(words1, words2)
    return (math.acos(cos_sim) * 180) / 3.14159265

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

corpus = [badger, bluewhale, chimpanzee, elephant, giraffe, hamster, manatee, polarbear, rhino, snail, okapi]

cleaned_word_lists = [remove_stop_words(string_to_list_of_natlang_words(doc)) for doc in corpus]

def all_pairs_checksum():
    total = 0
    n = len(cleaned_word_lists)
    for i in range(0, n):
        wi = cleaned_word_lists[i]
        for j in range(i + 1, n):
            angle = angle_difference_lists(wi, cleaned_word_lists[j])
            total = total + math.floor(angle * 1000 + 0.5)  # num-round (half up)
    return total

def run(iters, acc):
    while iters > 0:
        acc = acc + all_pairs_checksum()
        iters = iters - 1
    return acc

t0 = time.perf_counter()
result = run(120, 0)
t1 = time.perf_counter()
print(result)
print("LOOP-MS %d" % round((t1 - t0) * 1000))
