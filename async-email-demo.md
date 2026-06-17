# Stopify/Pyret runtime in <50 lines with this one weird trick

Ben and I worked this out today.

Note that this gives the full feature set – deep stacks, user interruption, etc.

The code transformation is roughly:

- Make all user functions async
- Make all function calls async
- Add checkPause at the top of every function and loop

I tried to get Rachit to implement this in 2018 with a vague “you can do it all with async!” but (a) async support was not really there yet and (b) there were lots of other things to try.

On this microbenchmark, this is competitive with Stopify in default configurations (and both are significantly slower than Pyret of today; this is mostly a property of deep stacks being particularly performant in Pyret's transformation).

One thing that's interesting about this, from our perspective of dealing with the JS <-> Pyret interop for so long, is that this gives a much clearer picture of what's going on from mixes of JS and Pyret callbacks – all Pyret functions are async, and any raw JS libraries should deal with that (and types help a lot here!).

(Would need a processEvent analog and a queue to manage it so that simulated multi-threading of user code isn't introduced if multiple logical Pyret/user code functions are supposed to run in response to events)


const delay = 50;
const start = performance.now();
const initFuel = 1000;
let fuel = initFuel;
let signal, pause;

// This is ~abstractRunner.ts in Stopify or ~runtime.run() in Pyret
async function topLoop() {
  while(true) {
    const { promise: newSignal, resolve: newPause } = Promise.withResolvers();
    signal = newSignal;
    pause = newPause;

    // Yield control back for whoever signals us, using the pause resolver
    console.log("Event loop ready at ", performance.now(start));
    const restart = await signal;
    setTimeout(() =>{
      restart();
    }, delay);
  }
}

async function checkPause() {
  fuel -= 1;
  if(fuel === 0) {
    fuel = initFuel;
    const { promise: pending, resolve: restart } = Promise.withResolvers();
    // The brain-twisty line – give topLoop the function it needs to restart
    // the paused user code by restarting the `pending` promise it is awaiting
    pause(restart);
    return pending;
  }
  else {
    return;
  }
}

// start the event loop listener; don't await it! Just let it run.
topLoop();




// Assume the user wrote roughly:
/*
fun sum(n):
  if n == 0: 0
  else:
    n + sum(n - 1)
  end
end
*/
async function sum(n) {
  // will pause here if fuel runs out, waiting for topLoop to call restart()
  await checkPause();
  if(n === 0) {
    return 0;
  }
  else {
    // Note every user function call must be async!
    return n + await sum(n - 1);
  }
}



const ans = await sum(100000);
console.log(ans);
