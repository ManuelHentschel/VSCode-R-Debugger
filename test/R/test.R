


print("This will be printed with debugMode==file or debugMode==function")
print("A breakpoint here should work with debugMode==file or from .vsc.debugSource()")
print("A breakpoint here should NOT work with debugMode==function")



foo <- function(x,y){
  print(x)
  print("A breakpoint here should work with debugMode==function")
  print("A breakpoint here should also work from the debug console, if .vsc.debugSource() or debugMode==file was used")
  # Currently, breakpoints are only set during runtime, when .vsc.debugSource() is called
  # Also, breakpoints are 'permanent' and can only be deactivated by calling .vsc.debugSource() again
  # In the future this should be refined by using trace(..., tracer=browser), to facilitate better breakpoint setting/clearing

  print(y)
  return(x+y)
}

main <- function(){
  print(1)
  print("This should only be printed if debugMode==function or main() was entered into the debug console")
  foo(2,3)
}


