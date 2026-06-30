#lang racket

(require txexpr)
(require pollen/core)
(require pollen/tag)

(require racket/date)

(require "pollenboots/utils.rkt")

(provide (all-defined-out))

(define (emph . elems)
  `(i () ,@elems))

(define (bold . elems)
  `(b () ,@elems))

(define (centered . elems)
  `(div ([align "center"]) ,@elems))

(define (code . elems)
  `(code ([class "uncolored-code"]) ,@elems))

(define (author . elems)
  `(div ([class "author"]) "by " ,@elems))

(define (get-date)
  (date->string (current-date)))

(define (include-section file)
  `(include-section-1 ([incfile ,file])))

; sections

(define (section-at-depth n title-elems #:tag [tag #f])
  (define title-sluggified (or tag (sluggify* title-elems)))
  (cond [(not (number? n))
         `(h5 ([id ,title-sluggified]) ,@title-elems)]
        [else
          (define level (number->string n))
          `(section-1 ([level ,level] [id ,title-sluggified]) ,@title-elems)]))

(define (section #:tag [tag #f] #:tag-prefix [tag-prefix #f] . titlex)
  (section-at-depth #:tag tag 2 titlex))
(define (subsection #:tag [tag #f] . titlex) (section-at-depth #:tag tag 3 titlex))
(define (subsubsection #:tag [tag #f] . titlex) (section-at-depth #:tag tag 4 titlex))

(define (subsubsub*section #:tag [tag #f] . titlex) (section-at-depth #:tag tag #f titlex))

(define (title #:tag [tag #f] #:version [version "0"]
               #:friendly-title [friendly-title #f]
               #:noimport [noimport #f]
               #:style [style #f]
               . title-terms)
  (define title-1
    (cond [friendly-title (list friendly-title)]
          [else title-terms]))
  (define title-sluggified
    (cond [tag tag]
          [friendly-title (sluggify friendly-title)]
          [else (sluggify* title-terms)]))
  `(title-1 ([level "1"] [id ,title-sluggified]) ,@title-1))

; Walk a docmodule body, collecting, in document order, every ◊section
; heading and every ◊function/◊method-doc/◊form/◊type-spec definition
; (the latter are marked with data-toc-fname/data-toc-label attributes
; by verbatim.rkt and pyret-docs.rkt). Recurses into nested txexprs so
; definitions wrapped in other tags are still found.
(define (local-toc-collect elems)
  (define acc '())
  (define (walk x)
    (cond
      [(and (txexpr? x) (eq? (get-tag x) 'section-1))
       (set! acc (cons (list 'section (attr-ref x 'id) (get-elements x)) acc))]
      [(and (txexpr? x) (eq? (get-tag x) 'div) (attr-ref x 'data-toc-fname #f))
       (set! acc (cons (list 'func (attr-ref x 'data-toc-fname) (attr-ref x 'data-toc-label)) acc))]
      [(txexpr? x) (for-each walk (get-elements x))]
      [else (void)]))
  (for-each walk elems)
  (reverse acc))

; Group the flat, ordered (section . funcs) entries into a nested
; structure: each section heading owns the functions that follow it,
; up to the next section heading. Functions with no preceding section
; (rare) are collected into a top-level preamble group.
(define (local-toc-group entries)
  (define groups '())
  (define preamble '())
  (define current-sec #f)
  (define current-children '())
  (define (flush!)
    (when current-sec
      (set! groups (cons (list current-sec (reverse current-children)) groups))))
  (for ([e entries])
    (case (first e)
      [(section)
       (flush!)
       (set! current-sec e)
       (set! current-children '())]
      [(func)
       (if current-sec
           (set! current-children (cons e current-children))
           (set! preamble (cons e preamble)))]))
  (flush!)
  (list (reverse preamble) (reverse groups)))

(define (local-toc-func-item f)
  (define fname (second f))
  (define flabel (third f))
  `(li () (a ([href ,(string-append "#" fname)]) ,flabel)))

(define (local-toc-render preamble groups)
  (if (and (null? preamble) (null? groups))
      `(span ())
      `(ul ([class "local-toc"])
           ,@(map local-toc-func-item preamble)
           ,@(map (lambda (g)
                    (define sec (first g))
                    (define funcs (second g))
                    (define sec-id (second sec))
                    (define sec-title (third sec))
                    `(li ()
                         (a ([href ,(string-append "#" sec-id)]) ,@sec-title)
                         ,@(if (null? funcs)
                               '()
                               (list `(ul () ,@(map local-toc-func-item funcs))))))
                  groups))))

(define (local-toc body)
  (define-values (preamble groups) (apply values (local-toc-group (local-toc-collect body))))
  (local-toc-render preamble groups))

(define (docmodule name #:friendly-title [friendly-title #f] #:noimport [noimport #f] . body)
  `(div ()
        (module-tag-1 () ,name)
       ,(apply title #:tag name #:friendly-title (or friendly-title name) '())
       ,(if noimport `(span ())
            `(div ()
                  (p () "Usage:")
                  (pre ([class "pyret-highlight"]) "include " ,name)
                  (pre ([class "pyret-highlight"]) "import " ,name " as ...")))
       ,(local-toc body)
       ,@body))

(define (itemlist . elems)
  `(ul () ,@elems))

(define (item . elems)
  `(li () ,@elems))

(define (nested #:style [style #f] . elems)
  (define attribs
    (if style `([class "insetpara nested"]) `([class "nested"])))
  `(div ,attribs ,@elems))

(define (para #:style [style #f]. elems)
  (define attribs
    (if style `([class ,style]) `()))
  `(p ,attribs ,@elems))

(define (hyperlink url . elems)
  `(a ((href ,url)) ,@elems))

(define link hyperlink)

(define (image #:scale [scale 1] file)
  (let ([pct (format "~a%" (inexact->exact (* scale 100)))])
    `(img ([src ,file] [width ,pct]))))

(define pyret-method
  (case-lambda
    [(ig2 name)
     (ref-gloss (string-append "." name))]
    [(ig1 ig2 name mod)
     (ref-mod-gloss mod (string-append "." name))]
    [(ig1 ig2 name)
     (ref-gloss (string-append "." name))]))



(define (collection-doc name #:args [args #f] #:fields [fields '()] #:return [return ""] #:show-ellipses [show-ellipses #f])
  ; (printf "### collection-doc-3 ~s args= ~s fields= ~s return= ~s\n" name args fields return)
  (let ([x
          `(div ()
                ,(make-gloss name)
                (pre ([class "pyret-display"])
                "[" ,(ref-gloss name)
                ,(if args `(span () "(" ,@(add-between args ", ") ")") `(span ()))
                ": "
                ,@(add-between fields ", ")
                ", ...] -> "
                ,return))])
    ; (printf "### res = ~s\n" x)
    x))


(define (ignore . ign) "")

(define (doc-internal #:stack-unsafe [stack-unsafe #f] . elems)
  (if stack-unsafe
      `(div ()
            (span ([class "margin-note"])
                  "!→ means this function is not stack safe")
            (pre () ,@elems))
      `(div ()
            (pre ([class "pyret-display"]) ,@elems)
            )))

(define (margin-note* . elems)
  `(div ([class "margin-note"])
         ,@elems))

(define note margin-note*)

(define margin-note margin-note*)

(define (cpo-only . elems)
  `(div ([class "CPO"]) (div ([class "cpo-icon"]) ,@elems)))

(define (vscode-only . elems)
  `(div ([class "VSCode"]) (div ([class "vscode-icon"]) ,@elems)))

(define (cli-only . elems)
  `(div ([class "CLI"]) (div ([class "cli-icon"]) ,@elems)))

(define (vscode-cli-only . elems)
  `(div ([class "VSCodeCLI"]) (div ([class "vscode-cli-icon"]) ,@elems)))

(define (tabular #:sep [sep #f]
                 #:column-properties [column-properties #f]
                 #:row-properties [row-properties #f]
                 #:cell-properties [cell-properties #f]
                 #:style [style #f]
                 . rows)
  ; (printf "### doing tabular of ~s\n" rows)
  (define table-class "table table-sm")
  #;(for-each
    (lambda (row)
      (printf "### doing row...\n")
      (for-each
        (lambda (cell)
          (printf "### cell is ~s\n" cell))
        row))
    rows)
  `(table ([class ,table-class])
          (tbody ()
            ,@(for/list ([row (car rows)])
                `(tr ()
                     ,@(for/list ([cell row])
                         ; (printf "### cell is ~s\n" cell)
                         `(td () ,cell)))))))

(define (form a b . elems)
  ; (printf "doing form a = ~s\nb = ~s\nelems = ~s\n" a b elems)
  `(div ([data-toc-fname ,(sluggify a)] [data-toc-label ,a])
        ,(make-gloss a)
        (pre ([class "pyret-display"]) ,b)
        ,@elems))

(define (value #:style [style ""] name typ . elems)
  `(div ()
        ,(make-gloss name)
        (pre ([class "pyret-display"])
             ,name " :: " ,typ)
        ,@elems))

(define (type-spec #:alias [alias #f] #:private [private #f] type-name tyvars . body)
  ; (printf "### type-spec ~s ~s \n" type-name tyvars )
  (define og-type-name type-name)
  (cond [alias
          ; (printf "alias = ~s\n" alias)
          ; (set! type-name (string-append type-name " = " alias))
          ; (set! type-name (format "~a = ~a" type-name alias))
          `(div ([data-toc-fname ,(sluggify og-type-name)] [data-toc-label ,og-type-name]) ,(make-gloss og-type-name)
                (pre ([class "pyret-display"])
                     ,(ref-gloss og-type-name type-name))
                ,@body) ]
        [else
          (if (list? tyvars)
              (when (cons? tyvars)
                (set! type-name `(span () ,(ref-gloss og-type-name)
                                  "<"
                                  ,(apply string-append (add-between tyvars ", "))
                                  ">")))
              (set! body (cons  tyvars body)))
          `(div ([data-toc-fname ,(sluggify og-type-name)] [data-toc-label ,og-type-name])
                ,(make-gloss og-type-name)
                (pre ([class "pyret-display"]) ,type-name)
                ,@body)]))

(define (a-id name . args)
  (if (cons? args) (first args) name)) ;autoinclude tt?

(define (a-arrow . typs)
  ; (printf "### doing a-arrow of ~s\n" typs)
  (set! typs
    (filter (lambda (typ) (not (equal? typ "Brand"))) typs))
  (set! typs
    (map (lambda (typ) (if (null? typ) "()" typ)) typs))
  (when (= (length typs) 1)
    (set! typs (cons "()" typs)))
  (let ([res
          `(span () ,@(add-between typs ", " #:before-last " -> "))])
    ; (printf "### a-arrow produced ~s\n" res)
    res))

(define (p-a-arrow . typs)
  `(span () "(" ,(apply a-arrow typs) ")"))

(define (a-app base . typs)
  ; (printf "doing a-app base= ~s typs= ~s\n" base typs )
  (set! typs (map (lambda (typ)
                    (if (list? typ)
                        (if (and (> (length typ) 1) (memq (first typ) '(ref-gloss-1 span)))
                            typ
                            `(span () ,@(add-between typ ", ")))
                        typ)) typs))
  ; (printf "### typs is now ~s\n" typs)
  (set! typs `(span () ,@(add-between typs ", ")))
  (let ([x `(span () ,base "<" ,typs ">")])
    ; (printf "a-app ~s ~s ==> ~s\n" base typs x)
    x))

(define (a-ftype #:ml [ml #f] . typs)
  (let* ([arg-typs (drop-right typs 1)]
         [ret-typ (car (take-right typs 1))])
    (cond [ml
            `(span ()  "(\n  "
                   ,@(add-between arg-typs ",\n  ")
                   "\n)\n-> "
                   ,ret-typ)]
          [(null? arg-typs)
           `(span () " -> " ,ret-typ)]
          [else
            `(span () "(" (span () ,@(add-between arg-typs ", ")) ") -> "
                   ,ret-typ)])))

(define (p-a-ftype . typs)
  `(span () "(" ,(apply a-ftype typs) ")"))

(define (a-tuple . fields)
  `(span () "{" ,@(add-between fields ", ") "}"))

(define equal-always-op `(code "=="))
(define equal-now-op `(code "=~"))
(define identical-op `(code "<=>"))

(define (singleton-doc #:style [style ""] typename1 fieldname typename . elems)
  `(div ()
        ,(make-gloss fieldname)
        (pre ([class "pyret-display"]) ,(ref-gloss fieldname) " :: " ,typename)
        ,@elems))

(define (a-var-type val typ)
  `(span ([class "pyret-content"]) ,val " :: " ,typ))

(define (p-a-var-type val typ)
  `(span ([class "pyret-content"]) "(" ,val " :: " ,typ ")"))

(define (constructor-doc #:private [private #f] #:style [style #f] typename1 fieldname args typename . elems)
  ; (printf "constructor-doc typename1= ~s fieldname= ~s args= ~s typename= ~s elems= ~s\n" typename1 fieldname args typename elems)
  (let ([x
          `(div ()
                ,(make-gloss fieldname)
                (pre ([class "pyret-display"])
                     ,(ref-gloss fieldname) " :: ("
                     ,@(add-between
                         (map (lambda (arg)
                                `(span () ,(first arg) " :: " ,(second (third arg))))
                              args) ", ")
                     ") -> " ,typename)
                ,@elems
                (p) ;make-gloss seems to insert p on top, so match it with one on bottom
                )])
    ; (printf "x = ~s\n" x)
    x))

(define (colorful-function-series)
  ; (printf "### colorful-function-series\n")
  `(pre () "colorful-function-series"))

(define (a-chart-window)
  ; (printf "### a-chart-window\n")
  `(pre () "a-chart-window"))

(define (a-record . fields)
  ; (printf "### a-record ~s\n" fields)
  (append  '(span ())
           (list "{")
           (add-between fields ", ")
           (list "}")))

  ; (string-append "{"
  ;   (apply string-append (add-between fields ", ")) "}")

(define (a-field name type . desc)
  ; (printf "### a-field ~s ~s ~s\n" name type desc)
  `(span () ,name " :: " ,type))

  ; (string-append name " :: " type)

(define (append-gen-docs . desc)
  "")

(define (add-paras info)
     ; (printf "### add-paras ~s\n" info)
     ; (printf "### first info = ~s\n" (car info))
     ; (printf "### rest info = ~s\n" (add-between (cdr info) (para)))
     (let ([result
             `(,(car info) ,@(add-between (cdr info) (para)))]
             )
       ; (printf "### add-paras result = ~s\n" result)
       result
       ))

(define (bnf . terms)
  "<<BNF pending>>"
  )

; (define (nd elem)
;   `(span () ,(make-gloss (format "~a-~a" *bnf-type* elem)) "‹" ,elem "›"))

(define (nt elem)
  ; (printf "### nt ~s\n" elem)
  ; `(span () ,(ref-gloss (format "~a-~a" *bnf-type* elem) (string-append "‹" elem "›")))
  (ref-gloss (format "~a-~a" *bnf-type* elem) (string-append "‹" elem "›"))
  )

(define (anchor-nt? s)
  (and (list? s) (eq? (car s) 'ref-gloss-1)))

(define (anchor-nt s)
  (let ([name (third s)]
        [term (fifth s)])
    `(span () ,(make-gloss name) ,term)))

(define (tk str)
  ; standard Pyret token names
  `(b () ,(case str

            [("AS") "as"]
            [("ASK") "ask"]
            [("BANG") "!"]
            [("BAR") "|"]
            [("BLOCK") "block"]
            [("BLOCKCOLON") "block:"]
            [("CASES") "cases"]
            [("COLON") ":"]
            [("COLON-EQUALS") ":="]
            [("COLONCOLON") "::"]
            [("COMMA") ","]
            [("CARET") "^"]
            [("LAM") "lam"]
            [("DATA") "data"]
            [("DOC") "doc:"]
            [("DOT") "."]
            [("DOTS") "..."]
            [("ELSE") "else"]
            [("ELSECOLON") "else:"]
            [("ELSEIF") "else if"]
            [("END") "end"]
            [("EQUALS") "="]
            [("FOR") "for"]
            [("FROM") "from"]
            [("FUN") "fun"]
            [("HIDING") "hiding"]
            [("IF") "if"]
            [("IMPORT") "import"]
            [("INCLUDE") "include"]
            [("LANGLE") "<"]
            [("LBRACE") "{"]
            [("LOAD_TABLE") "load-table"]
            [("LPAREN") "("]
            [("METHOD") "method"]
            [("MODULE") "module"]
            [("NEWTYPE") "newtype"]
            [("OF") "of"]
            [("OTHERWISECOLON") "otherwise:"]
            [("PARENNOSPACE") "("]
            [("PARENSPACE") "("]
            [("PERCENT") "%"]
            [("PIPE") "|"]
            [("PROVIDE") "provide"]
            [("PROVIDE-TYPES") "provide-types"]
            [("PROVIDECOLON") "provide:"]
            [("RANGLE") ">"]
            [("RBRACE") "}"]
            [("REC") "rec"]
            [("REACTOR") "reactor"]
            [("INIT") "init"]
            [("REF") "ref"]
            [("RPAREN") ")"]
            [("SANITIZE") "sanitize"]
            [("SEMI") ";"]
            [("SHADOW") "shadow"]
            [("SHARING") "sharing:"]
            [("SOURCECOLON") "source:"]
            [("SPY") "spy"]
            [("LET") "let"]
            [("TYPE-LET") "type-let"]
            [("LETREC") "letrec"]
            [("STAR") "*"]
            [("TABLE-EXTEND") "extend"]
            [("TABLE-EXTRACT") "extract"]
            [("TABLE-SELECT") "select"]
            [("TABLE-FILTER") "sieve"]
            [("TABLE-TRANSFORM") "transform"]
            [("TABLE-ORDER") "order"]
            [("TABLE") "table:"]
            [("ASCENDING") "ascending"]
            [("DESCENDING") "descending"]
            [("ROW") "row:"]
            [("THENCOLON") "then:"]
            [("THICKARROW") "=>"]
            [("THINARROW") "->"]
            [("TYPE") "type"]
            [("USING") "using"]
            [("VAR") "var"]
            [("WHEN") "when"]
            [("WHERE") "where:"]
            [("WITH") "with"]

            [else "UNDEFINED_TOKEN"]
            )))


(define (py-prod elem)
  ; (printf "### py-prod ~s\n" elem)
  `(span () ,(ref-gloss (format "~a-~a" "Pyret" elem) (string-append "‹" elem "›"))))

(define (tm elem)
  `(b () ,elem))

(define (tmi elem)
  `(b () (i () ,elem)))

(define *bnf-type* 'Pyret)

(define (ebnf type . elems)
  ; (printf "\n\nBNF\n\n")
  ; (for ([elem elems])
  ;   (printf "elemX = ~s\n" elem))
  (set! *bnf-type* type)
  (let ([out-elems #f]
        [lhs? #t])
    (set! out-elems (map (lambda (s)
                           (cond [(not (string? s))
                                  (cond [(not lhs?) s]
                                        [(anchor-nt? s) (set! lhs? #f) (anchor-nt s)]
                                        [else s])]
                                 [(string=? s "\n") (set! lhs? #t) `(br ())]
                                 [(and lhs? (regexp-match "^ *: *$" s))
                                  (set! lhs? #f) s]
                                 [else s]))
                         elems))
    `(div ([class "bnf"])
          ,@out-elems)))

(define (lbrace)
  `(span () "{"))

(define (rbrace)
  `(span () "}"))
