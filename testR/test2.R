g <- function(){
    # browser()
    a <- 1
    b <- 2
    c <- 'asdf'
    print(1)
    print(2)
}


hh <- function(a=2, ...){
    h(a)
}

h <- function(a=2, ...){
    dumpInfos()
}


dumpInfos <- function(){
    .vsc.getStack()
}