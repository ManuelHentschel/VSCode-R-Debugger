

print('sourcing stuff!')


g <- function(){
  1234
}

foo <- function(x, y) {
  print(x)
  print(y)
  browser()
  x + y
}

bar <- function(x, n) {
  z <- x
  for (i in seq_len(n)) {
    print(i)
    z <- foo(z, x)
  }
  z
}


main <- function(){
  kjkjlkjlkjlkjlk
  bar(2, 5)
}

# main()
