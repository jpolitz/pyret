#lang racket

(require "pollenboots/utils.rkt")

(provide (all-defined-out))

(define (pyret #:style [style #f] . elems)
  `(tt ([class "pyret-highlight"]) ,@elems))

(define (pyret-id item [mod #f])
  (ref-gloss item (pyret item) #:mod mod))

(define (tt . elems)
  `(tt () ,@elems))

(define (save-example-to-file code file)
  (call-with-output-file file
    (lambda (o)
      (fprintf o "# example in ~s, saved to ~s\n" (calc-here-path-from-project-root) file)
      (display code o))
    #:exists 'replace))

(define get-examples-count (make-counter))

(define *example-preamble-string* "")

(define *functions-tested* '())
(define *functions-untested* '())

(define (log-untested-functions)
  (let ([functions-without-examples-file (build-path *project-root* "_untested-functions.rkt")])
    (call-with-output-file functions-without-examples-file
      (lambda (o)
        (let ([i 0])
          (for ([f *functions-untested*])
            (display f o) (display " " o)
            (set! i (+ i 1))
            (when (>= i 6) (newline o) (set! i 0)))
          (newline o)))
      #:exists 'replace)))

(define (contains-keyword? f code)
  (define (contains-f? code) (contains-keyword? f code))
  (cond [(string? code) (regexp-match f code)]
        [(list? code) (ormap contains-f? code)]
        [else #f]))

(define (prune-functions-tried code)
  ; (printf "*** functions-defined = ~s\n" *functions-untested*)
  ; (printf "*** doing prune-functions-tried-in-string ~s\n" code)
  (let ([updated-functions-untested '()])
    (for ([f *functions-untested*])
      (if (contains-keyword? f code)
          (set! *functions-tested* (cons f *functions-tested*))
          (set! updated-functions-untested (cons f updated-functions-untested))))
    (set! *functions-untested* updated-functions-untested))
  ; (printf "*** functions-defined' = ~s\n" *functions-untested*)
  (log-untested-functions))

(define (example-preamble . elems)
  (set! *example-preamble-string* (string-join elems " "))
  "")

(define (examples #:show-try-it [show-try-it #t] #:load-preamble [load-preamble #f] . elems)
  (define code (string-join elems " "))
  (when (and show-try-it
             (not (or (regexp-match "check:" code) (regexp-match "examples:" code))))
    (set! show-try-it #f))
  (if show-try-it
      (let ()
        (define file (format ".examples-~a.arr" (get-examples-count)))
        (when load-preamble
          (set! code (string-append *example-preamble-string* "\n" code)))
        (prune-functions-tried code)
        (save-example-to-file code file)
        `(div ([class "examples"])
              (div ([class "SIntrapara"])
                   (p () (b () "Examples:"))
                   (pre ([class "pyret-highlight"]) ,@elems)
                   (a ([class "show-embed"]
                       [code ,code])
                      "(Try it!)"))))
      (let ()
        ; (define elem-string (apply string-append elems))
        ; (printf "WARNING: examples ~s missing try-it in ~a\n" elem-string (calc-here-path-from-project-root))
        `(div ([class "examples"])
              (div ([class "SIntrapara"])
                   (p () (b () "Examples:"))
                   (pre ([class "pyret-highlight"]) ,@elems))))))

(define (verbatim #:style [style "nothing_special"] #:show-try-it [show-try-it #f] . elems)
  ; (printf "@@@ doing verbatim ~s\n" elems)
  (define attribs `([class ,style]))
  `(pre ,attribs ,@elems))

(define codedisp verbatim)

(define (pyret-block #:style [style #f] #:show-try-it [show-try-it #f] . elems)
  (define classes (string-append (if style (string-append style " ") "") "pyret-highlight"))
  `(pre ([class ,classes]) ,@elems))

(define (data-spec name . elems)
  ; (printf "### data-spec ~s ~s \n" name elems)
  `(div ()
        ,(make-gloss name)
        ,@elems))

(define (variants . elems)
  ; (printf "### variants ~s\n" elems)
  `(div ()
        ,@elems))

(define (shared . elems)
  `(div ()
        (div ([class "nested"]) "Shared Methods")
        ,@elems))

(define (constr-spec name . elems)
  `(div ()
        (pre () ,name)
        ,@elems))

(define (members . elems)
  `(div ()
        (div ([class "nested"]) "Fields")
        ,@elems))

(define (with-members . elems)
  `(div ()
        (div ([class "nested"]) "Methods")
        ,@elems))

(define (method-spec #:params [params #f] #:contract [contract #f] #:return [return #f]
                     #:doc [doc #f]
                     #:args [args #f] #:alt-docstrings [alt-docstrings #f]
                     #:examples [examples '()] name . elems)
  ; (printf "### method-spec ~s ~s ~s\n" contract name elems)
  (define mname (string-append "." name))
  `(div ([class "nested"])
        (tt ([class "pyret-display"])
            ,(if contract `(span () ,mname " :: " ,contract)
                 mname))
        ,(if doc `(div () ,doc) "")
        ,@elems))

(define (member-spec #:type [type #f] #:contract [contract #f] fname . elems)
  ; (printf "*** member-spec fname= ~s contract= ~s elems= ~s\n" fname contract elems)
  `(div ([class "nested"])
        (tt ()
            ,(if contract
                 `(span () ,fname " :: " ,contract)
                 fname))
        ,@elems))

(define (data-spec2 #:no-toc [no-toc #f] name deps clauses)
  ; (printf "### doing data-spec2 ~s deps=~s ~s\n" name deps clauses)
  `(pre ([class "pyret-display"])
        ,(make-gloss name)
        (span ()
              "data " ,(ref-gloss name)
              ,@(if (and deps (cons? deps))
                    (append (list "<") (add-between deps ", ")  (list ">"))
                    '()))
          "\n"
         (div ()
                ,@(add-between
                    (map
                      (lambda (clause)
                        `(tt () "   | " ,clause))
                      clauses) "\n"))
          (tt () "end")))

(define (singleton-spec2 cname name)
  `(span () ,(ref-gloss name)))

(define (constructor-spec cname name [args #f])
  ; (printf "### constructor-spec cname= ~s name= ~s args= ~s\n" cname name args)
  (let ([x
          (if (not args)
              `(span () ,(ref-gloss name))
              `(span () ,(ref-gloss name)
                     "(" ,@(add-between
                             (map (lambda (arg)
                                    (define fname (first arg))
                                    (define contract (second (third arg)))
                                    ; (printf "fname= ~s contract= ~s\n" fname contract)
                                    `(span () ,fname " :: " ,contract))
                                  args)
                             ", ")
                     ")"))])
    ; (printf "### x= ~s\n" x)
    x))

(define (contains-examples? s)
  (if (list? s)
      (if (and (>= (length s) 3)
               (eq? (car s) 'div)
               (equal? (cadr s) '((class "examples"))))
          #t
          (ormap contains-examples? s))
      #f))

(define (function #:contract [contract #f] #:args [args #f]
                  #:return [return "return"]
                  #:examples [examples #f]
                  #:alt-docstrings [alt-docstrings "alt-docstrings"]
                  name . elems)
  ; (printf "*** adding function ~s\n" name)
  ; (printf "function ~a, elems = ~s, examples = ~s\n" name elems examples)
  (when examples
    (set! elems (append elems (list examples))))
  ; (printf "function ~a, elems = ~s, examples = ~s\n" name elems examples)
  (unless (or (contains-examples? elems)
              (member name *functions-tested*)
              (member name *functions-untested*))
    (set! *functions-untested* (cons name *functions-untested*))
    ; (printf "functions-defined = ~s\n" *functions-untested*)
    )
  `(div ()
        ,(make-gloss name)
        (pre ([class "pyret-display"])
             ,(ref-gloss name) " :: "
             ,(if (and args (not contract))
                  `(span ()
                        "(" ,@(add-between
                                (map (lambda (arg)
                                       (let ([arg (first arg)]
                                             [type (second arg)])
                                         ; (printf "arg/type are ~s, ~s\n" arg type)
                                         (cond [type
                                                 `(span () ,arg " :: " ,type)]
                                               [(list? contract)
                                                ; (printf "contract = ~s\n" contract)
                                                (let ([n (length contract)])
                                                  (let ([res
                                                          (if (>= n 3)
                                                              `(span () ,arg " :: "
                                                                     ,(third contract))
                                                              `(span () "() -> "
                                                                     ,(second contract)))])
                                                    ; (printf "done V\n")
                                                    res
                                                    ))]
                                               [else
                                                 arg])))
                                     args) ", ")
                        ")"
                        )
                  ; contract
                  (or contract "unspecified_contract")
                  ))
        ,@elems))

(define (method-doc #:alt-docstrings [alt-docstrings #f] #:contract [contract #f]
                    #:args [args "args"] #:return [return "return"]
                    data-name var-name name
                    . elems)
  ; (printf "### method-doc\n")
  (define methname (string-append "." name))
  (set! *functions-untested* (cons methname *functions-untested*))
  (unless contract (set! contract "unspecified_contract"))
  `(div ()
        ,(make-gloss methname)
        (pre ([class "pyret-display"])
             ,methname " :: " ,contract)))

(define (repl-examples . elems)
  ; (printf "### repl-examples ~s\n" elems)
  (prune-functions-tried elems)
  `(div ([class "repl-examples"])
        ,@(map (lambda (elem)
                 ; (printf "### elem = ~s\n" elem)
                 (define kar (car elem))
                 (set! kar
                   (map (lambda (x)
                          (if (and (string? x)
                                   (regexp-match-exact? #rx" +" x))
                              (string-append "   " x)
                              x))
                        kar))
                 ; (printf "### car elem = ~s\n" kar)
                 ; (printf "### cdr elem = ~s\n" (cdr elem))
                 `(div ([class "repl-example"])
                      (pre ([class "pyret-highlight"])
                           ,@kar)
                      ,@(cdr elem)))
               elems)))
