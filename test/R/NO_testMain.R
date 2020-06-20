
bar <- function(x, n) {
  z <- x
  for (i in seq_len(n)) {
    print(i)
    z <- foo(z, x)
  }
  z
}


main <- function(){
  bar(2, 5)
}

# main()
