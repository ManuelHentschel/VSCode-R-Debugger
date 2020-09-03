
# options(vsc.showCustomAttributes = FALSE)
# options(vsc.verboseVarInfos=TRUE)

# l <- list(a=1, b=2)

# l <- list(a=1, b=2, c=3)

# l$nested <- l

# x <- array(1:1000000, c(100,100,100))

# v <- 1:10000


# l <- replicate(10000, v, simplify=FALSE)

# v <- 1:3

options(vsc.showInternalFrames = TRUE)

print(1)
print(2)
print(3)

g <- function(){
    print(1:5)
}

f <- function(x=9){
    print('ja....')
    print(x)
    print('..woll')
    return(runif(1))
}

main <- function(){
    print('hello world')
    f(4)
    print('done.')
}

# if(.vsc.getSession('debugMode', 'none')!='function'){
#     print('Calling main() from file')
#     main()
# }

# print(1)
# print(2)
# print(3)



